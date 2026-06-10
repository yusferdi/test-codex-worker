import fs from 'fs-extra';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { getCaptchaTextFromGemini as solveCaptchaWithGemini } from './captchaSolver.js';
import { decodeDtsenResponse, encryptDtsenEntity } from './dtsenCrypto.js';
import { fetchWithTimeout } from './httpClient.js';
import { loginDirectSiks } from './siksDirectAuth.js';

const NO_INPUT_NAME_LABEL = 'TIDAK MEMILIKI NAMA';
const NO_HEAD_FAMILY_LABEL = 'TIDAK ADA KEPALA KELUARGA';
const NO_PADAN_DATA_LABEL = 'DATA PADAN TIDAK DITEMUKAN';

export class SiksChecker {
  constructor(config, jobDir) {
    this.config = config;
    this.selectors = config.siksSelectors || {};
    this.setJobDir(jobDir);
    this.browser = null;
    this.page = null;
    this.telegramPage = null;
    this.authorizationHeader = '';
    this.authorizationWaiters = [];
    this.lastSessionProbeAt = 0;
    this.sessionRecoveryPromise = null;
  }

  setJobDir(jobDir) {
    this.jobDir = jobDir;
    this.riwayatFile = path.join(jobDir, 'riwayat_bansos.jsonl');
    this.prevMap = loadPreviousResults(this.config.archiveFile);
  }

  async ensureJobFiles() {
    await fs.ensureDir(this.jobDir);
    await fs.ensureFile(this.config.archiveFile);
  }

  isHealthy() {
    if (this.isDirectAuth()) {
      return Boolean(this.authorizationHeader);
    }
    return Boolean(
      this.browser?.isConnected?.()
      && this.page
      && !this.page.isClosed?.()
    );
  }

  async prepareForJob(jobDir) {
    this.setJobDir(jobDir);
    await this.ensureJobFiles();
    if (this.isDirectAuth()) {
      try {
        await this.ensureDirectLoggedIn({ reason: 'reuse auth direct antar-job' });
        return true;
      } catch {
        return false;
      }
    }
    if (!this.isHealthy()) {
      return false;
    }

    try {
      await this.page.bringToFront();
      await this.ensureActiveSession({ force: true, reason: 'reuse browser antar-job' });
      return true;
    } catch {
      return false;
    }
  }

  async init() {
    await this.ensureJobFiles();
    if (this.isDirectAuth()) {
      await this.ensureDirectLoggedIn({ force: true, reason: 'init auth direct' });
      return;
    }
    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      executablePath: this.config.chromeExecutablePath,
      userDataDir: this.config.siksUserDataDir,
      defaultViewport: null,
      timeout: this.config.browserLaunchTimeoutMs,
      protocolTimeout: this.config.browserLaunchTimeoutMs,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.page = await this.browser.newPage();
    this.page.setDefaultTimeout(this.config.pageDefaultTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.config.pageDefaultTimeoutMs);
    this.installAuthorizationCapture();
    await this.ensureLoggedIn();
    await this.prepareDtsenApi({ forceFresh: true });
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.telegramPage = null;
    this.lastSessionProbeAt = 0;
    this.sessionRecoveryPromise = null;
    this.resolveAuthorizationWaiters('');
    if (browser) {
      await withTimeout(browser.close(), this.config.browserCloseTimeoutMs, 'Timeout menutup Puppeteer.').catch(() => {
        try {
          browser.process?.()?.kill?.('SIGKILL');
        } catch {
          // ignore kill errors on Windows or when process already exited
        }
      });
    }
  }

  isDirectAuth() {
    return isDirectAuthMode(this.config.siksAuthMode);
  }

  async ensureDirectLoggedIn({ force = false, reason = 'auth direct' } = {}) {
    const intervalMs = Math.max(0, Number(this.config.siksSessionProbeIntervalMs || 0));
    const probeStillFresh = this.authorizationHeader
      && this.lastSessionProbeAt > 0
      && intervalMs > 0
      && Date.now() - this.lastSessionProbeAt < intervalMs;
    if (!force && probeStillFresh) {
      return this.authorizationHeader;
    }

    const session = await loginDirectSiks(this.config, { jobDir: this.jobDir, reason });
    this.setAuthorizationHeader(session.authorization);
    this.lastSessionProbeAt = Date.now();
    return this.authorizationHeader;
  }

  installAuthorizationCapture() {
    const page = this.page;
    page.on('request', request => {
      const url = request.url();
      if (!matchesAnyUrlHost(url, this.config.dtsenAuthorizationHosts)) {
        return;
      }
      const headers = request.headers();
      this.setAuthorizationHeader(headers.authorization || headers.Authorization || '');
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && isLoginUrl(frame.url(), this.config.siksLoginUrl)) {
        this.clearAuthorizationHeader();
        this.lastSessionProbeAt = 0;
      }
    });
  }

  setAuthorizationHeader(value) {
    const header = String(value || '').trim();
    if (!header) {
      return;
    }
    this.authorizationHeader = header;
    this.resolveAuthorizationWaiters(header);
  }

  clearAuthorizationHeader() {
    this.authorizationHeader = '';
    this.resolveAuthorizationWaiters('');
  }

  resolveAuthorizationWaiters(value) {
    const waiters = this.authorizationWaiters.splice(0);
    for (const resolve of waiters) {
      resolve(value);
    }
  }

  async waitForAuthorizationHeader() {
    if (this.authorizationHeader) {
      return this.authorizationHeader;
    }

    const timeoutMs = Math.max(1000, Number(this.config.dtsenAuthTimeoutMs || 30000));
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(''), timeoutMs);
      timer.unref?.();
      this.authorizationWaiters.push(value => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async prepareDtsenApi({ forceFresh = false, allowRelogin = true } = {}) {
    if (this.isDirectAuth()) {
      if (forceFresh || !this.authorizationHeader) {
        await this.ensureDirectLoggedIn({ force: forceFresh, reason: 'prepare DTSEN direct' });
      }
      return this.authorizationHeader;
    }

    try {
      if (forceFresh) {
        this.clearAuthorizationHeader();
        await this.page.goto(this.config.dtsenPageUrl, { waitUntil: 'networkidle2' });
      } else {
        await this.openDtsenView().catch(async error => {
          await this.page.goto(this.config.dtsenPageUrl, { waitUntil: 'networkidle2' });
          if (!this.page.url().includes(this.config.siksDtsenViewPath || '/data-bnba-dtsen')) {
            throw new Error(`Gagal membuka halaman DTSEN setelah login: ${error.message}`);
          }
        });
      }

      await sleep(Math.max(0, Number(this.config.siksSessionSettleMs || 0)));
      if (await this.isLoginPageState()) {
        throw createSiksSessionExpiredError('SIKS mengalihkan halaman DTSEN kembali ke halaman login.');
      }

      const currentUrl = this.page.url();
      if (!currentUrl.includes(this.config.siksDtsenViewPath || '/data-bnba-dtsen')) {
        throw createSiksSessionExpiredError(`Halaman DTSEN tidak aktif setelah navigasi (${currentUrl}).`);
      }

      const authorization = await this.waitForAuthorizationHeader();
      if (!authorization) {
        throw createSiksSessionExpiredError('Authorization header DTSEN tidak tertangkap dari sesi browser.');
      }
      if (forceFresh) {
        this.lastSessionProbeAt = Date.now();
      }
      return authorization;
    } catch (error) {
      if (allowRelogin && (isSiksSessionExpiredError(error) || await this.isLoginPageState())) {
        await this.recoverSession(error.message);
        return this.authorizationHeader;
      }
      throw error;
    }
  }

  async ensureActiveSession({ force = false, reason = 'pemeriksaan sesi' } = {}) {
    if (this.isDirectAuth()) {
      await this.ensureDirectLoggedIn({ force, reason });
      return true;
    }

    if (!this.isHealthy()) {
      throw new Error('Browser atau halaman SIKS tidak aktif.');
    }

    const intervalMs = Math.max(0, Number(this.config.siksSessionProbeIntervalMs || 0));
    const probeStillFresh = this.authorizationHeader
      && this.lastSessionProbeAt > 0
      && Date.now() - this.lastSessionProbeAt < intervalMs;
    if (!force && probeStillFresh) {
      return true;
    }

    try {
      await this.page.bringToFront();
      await this.prepareDtsenApi({ forceFresh: true, allowRelogin: false });
      this.lastSessionProbeAt = Date.now();
      return true;
    } catch (error) {
      await this.recoverSession(`${reason}: ${error.message}`);
      return true;
    }
  }

  async recoverSession(reason = 'sesi SIKS kedaluwarsa') {
    if (this.sessionRecoveryPromise) {
      return this.sessionRecoveryPromise;
    }

    this.sessionRecoveryPromise = this.performSessionRecovery(reason)
      .finally(() => {
        this.sessionRecoveryPromise = null;
      });
    return this.sessionRecoveryPromise;
  }

  async performSessionRecovery(reason) {
    if (this.isDirectAuth()) {
      const maxAttempts = Math.max(1, Number(this.config.siksSessionRecoveryAttempts || 1));
      let lastError = createSiksSessionExpiredError(reason);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          this.clearAuthorizationHeader();
          await this.ensureDirectLoggedIn({ force: true, reason });
          return true;
        } catch (error) {
          lastError = error;
          this.clearAuthorizationHeader();
          if (attempt < maxAttempts) {
            await sleep(Math.max(500, Number(this.config.siksSessionRecoveryDelayMs || 0)));
          }
        }
      }
      throw createSiksSessionExpiredError(`Pemulihan sesi SIKS direct gagal setelah ${maxAttempts} percobaan. ${lastError.message}`);
    }

    const maxAttempts = Math.max(1, Number(this.config.siksSessionRecoveryAttempts || 1));
    let lastError = createSiksSessionExpiredError(reason);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.clearAuthorizationHeader();
        await this.page.bringToFront();
        await this.clearSiksAuthState();
        await this.ensureLoggedIn();
        await this.prepareDtsenApi({ forceFresh: true, allowRelogin: false });
        this.lastSessionProbeAt = Date.now();
        return true;
      } catch (error) {
        lastError = error;
        this.clearAuthorizationHeader();
        if (attempt < maxAttempts) {
          await sleep(Math.max(500, Number(this.config.siksSessionRecoveryDelayMs || 0)));
        }
      }
    }

    throw createSiksSessionExpiredError(`Pemulihan sesi SIKS gagal setelah ${maxAttempts} percobaan. ${lastError.message}`);
  }

  async clearSiksAuthState() {
    if (this.isDirectAuth()) {
      this.clearAuthorizationHeader();
      this.lastSessionProbeAt = 0;
      return;
    }

    if (!this.config.siksClearAuthStateOnRecovery) {
      return;
    }

    const urls = [
      this.config.siksBaseUrl,
      this.config.siksLoginUrl,
      this.config.dtsenPageUrl,
      this.config.siksAuthApiBaseUrl,
    ].filter(value => /^https?:\/\//i.test(String(value || '')));
    const cookies = await this.page.cookies(...urls).catch(() => []);
    if (cookies.length) {
      await this.page.deleteCookie(...cookies).catch(() => {});
    }

    await this.page.goto(this.config.siksLoginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.evaluate(() => {
      window.localStorage?.clear();
      window.sessionStorage?.clear();
    }).catch(() => {});
    this.clearAuthorizationHeader();
  }

  async isLoginPageState() {
    if (!this.page || this.page.isClosed?.()) {
      return false;
    }
    if (isLoginUrl(this.page.url(), this.config.siksLoginUrl)) {
      return true;
    }
    return this.page.evaluate(({ username, password, captcha }) => {
      return Boolean(
        (username && document.querySelector(username))
        || (password && document.querySelector(password))
        || (captcha && document.querySelector(captcha))
      );
    }, {
      username: this.selectors.loginUsername || '',
      password: this.selectors.loginPassword || '',
      captcha: this.selectors.captchaImage || '',
    }).catch(() => false);
  }

  async ensureLoggedIn() {
    if (this.isDirectAuth()) {
      await this.ensureDirectLoggedIn({ force: true, reason: 'ensure logged in direct' });
      return;
    }

    const page = this.page;
    await page.goto(this.config.siksLoginUrl, { waitUntil: 'networkidle2' });
    const isLoginPage = await page.$(this.selectors.loginUsername) !== null;
    if (!isLoginPage) {
      return;
    }

    if (!this.config.siksUsername || !this.config.siksPassword) {
      throw new Error('SIKS_USERNAME dan SIKS_PASSWORD wajib diisi di .env worker.');
    }

    await page.type(this.selectors.loginUsername, this.config.siksUsername, { delay: 40 });
    await page.type(this.selectors.loginPassword, this.config.siksPassword, { delay: 40 });
    const loginOk = await this.solveLoginCaptcha();
    if (!loginOk) {
      throw new Error('Login SIKS gagal setelah beberapa percobaan captcha.');
    }

    await this.fillOtpIfPresent();
  }

  async solveLoginCaptcha() {
    const page = this.page;
    const maxAttempts = Math.max(1, Number(this.config.siksCaptchaAttempts || 1));
    const actionTimeout = siksActionTimeout(this.config);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const imgHandle = await page.waitForSelector(this.selectors.captchaImage, { timeout: actionTimeout });
      const src = await imgHandle.getProperty('src').then(prop => prop.jsonValue());
      const base64 = String(src).replace(/^data:image\/\w+;base64,/, '');
      const imagePath = path.join(this.jobDir, 'captcha_raw.jpg');
      await fs.writeFile(imagePath, Buffer.from(base64, 'base64'));

      const captchaText = await solveCaptchaWithGemini(imagePath, this.config);
      await clearAndType(page, this.selectors.loginCaptcha, captchaText);
      await clickFirstButton(page);

      const detected = await page.waitForFunction(({ otpBox, alertDialog }) => {
        return document.querySelector(otpBox) || document.querySelector(alertDialog);
      }, { timeout: actionTimeout }, {
        otpBox: this.selectors.otpBox,
        alertDialog: this.selectors.alertDialog,
      }).catch(() => null);

      if (!detected) {
        continue;
      }
      const errorText = await page.$eval(this.selectors.alertDialog, el => el.innerText).catch(() => null);
      if (errorText && errorText.toLowerCase().includes('login gagal')) {
        await page.$eval(this.selectors.loginCaptcha, el => { el.value = ''; }).catch(() => {});
        continue;
      }
      return true;
    }
    return false;
  }

  async fillOtpIfPresent() {
    const page = this.page;
    if (!await hasOtpInputs(page, this.selectors.otpInputs)) {
      return;
    }

    if (!this.config.telegramOtpUrl) {
      throw new Error('OTP diperlukan, tetapi TELEGRAM_OTP_URL kosong.');
    }

    const attemptedOtps = new Set();
    const maxAttempts = Math.max(1, Number(this.config.siksOtpSubmitAttempts || 1));
    let lastFailure = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const otp = await this.readOtpFromTelegram({ excludedOtps: attemptedOtps });
      if (!otp) {
        throw new Error(`OTP baru tidak ditemukan dari Telegram setelah ${attemptedOtps.size} kode sebelumnya ditolak.`);
      }
      attemptedOtps.add(otp);

      await page.bringToFront();
      await page.waitForSelector(this.selectors.otpInputs, { timeout: siksActionTimeout(this.config) });
      await clearOtpInputs(page, this.selectors.otpInputs);
      const otpInputs = await page.$$(this.selectors.otpInputs);
      if (otpInputs.length < otp.length) {
        throw new Error(`Jumlah input OTP tidak cukup: ${otpInputs.length}/${otp.length}`);
      }

      for (let i = 0; i < otp.length; i++) {
        await otpInputs[i].focus();
        await page.keyboard.type(otp[i], { delay: 80 });
      }
      await clickOtpValidationButton(page, this.config);
      const validation = await waitAfterOtpValidation(page, this.config);
      if (validation.success) {
        return;
      }

      lastFailure = validation.errorText || 'OTP ditolak atau form OTP masih tampil.';
      await sleep(Math.max(250, Number(this.config.siksOtpRetryDelayMs || 0)));
    }
    throw new Error(`Login SIKS gagal setelah ${maxAttempts} percobaan OTP. ${lastFailure}`.trim());
  }

  async readOtpFromTelegram({ excludedOtps = new Set() } = {}) {
    if (!this.telegramPage) {
      this.telegramPage = await this.browser.newPage();
      this.telegramPage.setDefaultTimeout(this.config.pageDefaultTimeoutMs);
      this.telegramPage.setDefaultNavigationTimeout(this.config.pageDefaultTimeoutMs);
    }
    await this.telegramPage.bringToFront();
    if (!samePageUrl(this.telegramPage.url(), this.config.telegramOtpUrl)) {
      await this.telegramPage.goto(this.config.telegramOtpUrl, { waitUntil: 'networkidle2' });
    }
    await this.telegramPage.waitForSelector(this.config.telegramMessageSelector, { timeout: telegramOtpWaitTimeout(this.config) });

    const maxAttempts = excludedOtps.size > 0
      ? Math.max(1, Number(this.config.telegramNewOtpWaitAttempts || this.config.telegramOtpReadAttempts || 1))
      : Math.max(1, Number(this.config.telegramOtpReadAttempts || 1));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await scrollTelegramChatToBottom(this.telegramPage, this.config.telegramMessageSelector, this.config);
      const otpMessage = await readBottomOtpMessage(this.telegramPage, this.config.telegramMessageSelector, this.config);
      const otp = matchOtpFromMessage(otpMessage, this.config.telegramOtpPrefix);
      if (otp && !excludedOtps.has(otp)) {
        return otp;
      }
      await sleep(1000);
    }

    return '';
  }

  async openDtsenView() {
    const page = this.page;
    await page.waitForFunction((arrowText) => {
      return Array.from(document.querySelectorAll('span')).some(span => span.textContent.trim() === arrowText);
    }, { timeout: siksActionTimeout(this.config) }, this.config.siksMenuArrowText).catch(() => null);

    await page.evaluate((arrowText) => {
      const span = Array.from(document.querySelectorAll('span')).find(el => el.textContent.trim() === arrowText);
      if (span) span.click();
    }, this.config.siksMenuArrowText).catch(() => {});
    await page.click(this.selectors.treeItemLabel).catch(() => {});

    await page.waitForFunction((menuText) => {
      return Array.from(document.querySelectorAll('p')).some(el => el.textContent.trim() === menuText);
    }, { timeout: siksActionTimeout(this.config) }, this.config.siksDtsenMenuText);

    await page.evaluate((menuText) => {
      const target = Array.from(document.querySelectorAll('p')).find(el => el.textContent.trim() === menuText);
      if (target) target.click();
    }, this.config.siksDtsenMenuText);
    await page.waitForSelector(this.selectors.nikInput, { timeout: siksSearchTimeout(this.config) });
  }

  async checkEntry(entry) {
    await this.ensureActiveSession({ reason: `sebelum memeriksa NIK ${entry.nik || '-'}` });
    try {
      const family = await this.fetchDtsenFamily(entry.nik, '');
      const related = family ? await this.fetchDtsenRelatedData(family) : {};
      const result = family ? this.makeDtsenApiResult(entry, family, related, 'NEW') : this.makeNotRegisteredResult(entry);
      await this.appendArchive(result);
      return result;
    } catch (error) {
      if (entry.kk && entry.kk !== entry.nik) {
        const byKk = await this.fetchDtsenFamily('', entry.kk).catch(byKkError => {
          if (isEmptyDtsenResultError(byKkError)) {
            return null;
          }
          throw byKkError;
        });
        if (byKk) {
          const related = await this.fetchDtsenRelatedData(byKk);
          const result = this.makeDtsenApiResult(entry, byKk, related, 'FOUND_BY_KK');
          await this.appendArchive(result);
          return result;
        }
      }

      if (isEmptyDtsenResultError(error)) {
        const result = this.makeNotRegisteredResult(entry);
        await this.appendArchive(result);
        return result;
      }

      throw error;
    }
  }

  async fetchDtsenFamily(nik, nokk) {
    const payload = createDtsenSearchPayload({ nik, nokk });
    const responseData = await this.postDtsenPayload(this.config.dtsenApiUrl, payload);
    const rows = Array.isArray(responseData?.data) ? responseData.data : [];
    if (!rows.length) {
      const error = new Error(this.config.siksNotFoundText || 'Data Tidak Ditemukan');
      error.code = 'DTSEN_EMPTY';
      throw error;
    }
    return rows[0];
  }

  async fetchDtsenRelatedData(family) {
    const idKeluarga = String(family?.id_keluarga || '').trim();
    const idWilayah = String(family?.id_wilayah || '').trim();
    if (!idKeluarga) {
      return {
        detailError: 'id_keluarga kosong dari hasil pencarian DTSEN.',
        desilError: 'id_keluarga kosong dari hasil pencarian DTSEN.',
        anggotaError: 'id_keluarga kosong dari hasil pencarian DTSEN.',
      };
    }

    const [detail, desil, anggota] = await Promise.all([
      this.postDtsenPayload(this.config.dtsenDetailKeluargaApiUrl, { id_keluarga: idKeluarga, id_wilayah: idWilayah })
        .then(data => ({ data: data?.data || data }))
        .catch(error => ({ error: error.message, sessionExpired: isSiksSessionExpiredError(error) })),
      this.postDtsenPayload(this.config.dtsenDesilApiUrl, { id_keluarga: idKeluarga })
        .then(data => ({ data: data?.data || data }))
        .catch(error => ({ error: error.message, sessionExpired: isSiksSessionExpiredError(error) })),
      this.postDtsenPayload(this.config.dtsenAnggotaApiUrl, { id_keluarga: idKeluarga })
        .then(data => ({ data: Array.isArray(data?.data) ? data.data : [] }))
        .catch(error => ({ error: error.message, sessionExpired: isSiksSessionExpiredError(error) })),
    ]);

    const expiredResult = [detail, desil, anggota].find(result => result.sessionExpired);
    if (expiredResult) {
      throw createSiksSessionExpiredError(expiredResult.error);
    }

    return {
      detailKeluarga: detail.data || null,
      desilDetail: desil.data || null,
      anggotaKeluarga: anggota.data || [],
      detailError: detail.error || '',
      desilError: desil.error || '',
      anggotaError: anggota.error || '',
    };
  }

  async postDtsenPayload(url, payload) {
    const maxAttempts = Math.max(1, Number(this.config.dtsenApiRetryAttempts || 1));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (!this.authorizationHeader) {
          await this.ensureActiveSession({ force: true, reason: 'authorization DTSEN kosong' });
        }

        const form = new FormData();
        form.append('entity', encryptDtsenEntity(JSON.stringify(payload), this.config.dtsenAppKey, this.config.dtsenCrypto));
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            authorization: this.authorizationHeader,
            referer: this.config.siksOrigin,
          },
          body: form,
        }, {
          timeoutMs: this.config.dtsenApiTimeoutMs,
          timeoutMessage: `DTSEN API timeout setelah ${Math.round(Number(this.config.dtsenApiTimeoutMs || 0) / 1000)} detik.`,
        });
        const rawText = await response.text();
        let decoded = null;
        try {
          decoded = decodeDtsenResponse(rawText, this.config.dtsenAppKey, this.config.dtsenCrypto);
        } catch (decodeError) {
          if (response.status !== 401 && response.status !== 403 && !isLoginResponseText(rawText)) {
            throw decodeError;
          }
          throw createSiksSessionExpiredError(`DTSEN API mengembalikan halaman login atau autentikasi gagal (HTTP ${response.status}).`);
        }

        if (isDtsenSessionExpiredResponse(response.status, decoded, rawText)) {
          throw createSiksSessionExpiredError(decoded?.message || `DTSEN API HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new Error(decoded?.message || `DTSEN API HTTP ${response.status}`);
        }
        if (decoded?.status === false) {
          throw new Error(decoded?.message || 'DTSEN API mengembalikan status gagal.');
        }
        return decoded?.data && typeof decoded.data === 'object' ? decoded.data : decoded;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || isEmptyDtsenResultError(error)) {
          break;
        }
        if (isSiksSessionExpiredError(error)) {
          await this.recoverSession(error.message);
          continue;
        }
        await sleep(500 * attempt);
      }
    }

    throw lastError || new Error('DTSEN API gagal tanpa detail.');
  }

  async tryByKk(entry) {
    const first = await this.searchAndExtract(entry, entry.kk, true, 'FOUND_BY_KK').catch(() => null);
    if (first) return first;
    return this.searchAndExtract(entry, entry.kk, false, 'FOUND_BY_KK');
  }

  async searchAndExtract(entry, searchValue, useKkInput, baseStatus) {
    const page = this.page;
    await this.clearSearchInputs();
    const inputSelector = useKkInput ? this.selectors.kkInput : this.selectors.nikInput;
    await page.waitForSelector(inputSelector, { timeout: siksActionTimeout(this.config) });
    await page.type(inputSelector, searchValue, { delay: 35 });

    await page.waitForFunction((buttonText) => {
      return Array.from(document.querySelectorAll('button')).some(btn => btn.textContent.trim() === buttonText);
    }, { timeout: siksActionTimeout(this.config) }, this.config.siksSearchButtonText);
    await page.evaluate((buttonText) => {
      const button = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim() === buttonText);
      if (button) button.click();
    }, this.config.siksSearchButtonText);

    await page.waitForSelector(this.selectors.detailButton, { timeout: siksActionTimeout(this.config) });
    await page.click(this.selectors.detailButton);
    await page.waitForSelector(this.selectors.detailPanel, { timeout: siksActionTimeout(this.config) });

    const details = await this.extractDetailsAndRiwayat(entry.nik);
    const status = this.statusFor(entry.nik, details.desilText, baseStatus);
    const kkMatch = entry.kk ? (details.kkNumber && entry.kk === details.kkNumber ? 'YA' : 'TIDAK') : '';
    const inputName = inputNameFromEntry(entry);
    const result = {
      nik: entry.nik,
      source_sheet: entry.sheetName || '',
      input_nama: inputName,
      nama: details.personName || '',
      nama_sesuai_nik: details.personName || '',
      nik_kepala_keluarga: '',
      desil: details.desilText || '',
      date: new Date().toISOString(),
      status,
      screenshot: details.shotName || '',
      riwayat_file: this.riwayatFile,
      kk: details.kkNumber || '',
      kk_sama: kkMatch,
      nama_sama: nameMatchLabel(inputName, details.personName),
      id_keluarga: '',
      id_wilayah: '',
      nama_kepala_keluarga: '',
      alamat: '',
      provinsi: '',
      kabupaten: '',
      kecamatan: '',
      kelurahan: '',
      peringkat_nasional: '',
      peringkat_provinsi: '',
      peringkat_kab_kota: '',
      percentile_nasional: '',
      jumlah_anggota_keluarga: '0',
      anggota_keluarga: '',
      pekerjaan_sesuai_nik: '',
      pekerjaan_kepala_keluarga: '',
      status_aktif: '',
      keterangan_deleted: '',
      status_meninggal: '',
      status_kepala_keluarga: '',
      keterangan_deleted_kepala_keluarga: '',
      status_meninggal_kepala_keluarga: '',
      PKH: details.pkhHasOKT ? 'YA' : 'TIDAK',
      SEMBAKO: details.sembakoHasOKT ? 'YA' : 'TIDAK',
      PBI: details.pbiFlag || '',
      OKT_DES_2025: details.pkhHasOKT || details.sembakoHasOKT ? 'YA' : 'TIDAK',
      error: '',
    };
    await this.appendArchive(result);
    this.prevMap.set(entry.nik, details.desilText || '');
    await sleep(1000);
    return result;
  }

  async extractDetailsAndRiwayat(origNik) {
    const page = this.page;
    const desilText = await page.$eval(this.selectors.detailPanel, el => el.textContent.trim()).catch(() => '');
    const shotName = path.join(this.jobDir, `screenshot_${origNik}_${fileStamp()}.png`);
    await page.screenshot({ path: shotName, fullPage: true }).catch(() => {});
    const kkNumber = await extractKKNumber(page, this.config);
    const personName = await extractPersonName(page, origNik);
    const riwayat = await clickRiwayatAndExtract(page, origNik, this.riwayatFile, this.config);
    await closeDetailIfVisible(page, this.config);
    return { desilText, shotName, kkNumber, personName, ...riwayat };
  }

  async clearSearchInputs() {
    const page = this.page;
    for (const selector of [this.selectors.nikInput, this.selectors.kkInput]) {
      const handle = await page.$(selector);
      if (handle) {
        await handle.click({ clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.$eval(selector, el => { el.value = ''; }).catch(() => {});
      }
    }
  }

  async detectNotRegistered() {
    if (!this.page) {
      return false;
    }
    return this.page.evaluate((notFoundText) => (document.body.innerText || '').includes(notFoundText), this.config.siksNotFoundText).catch(() => false);
  }

  makeNotRegisteredResult(entry) {
    const inputName = inputNameFromEntry(entry);
    const result = {
      nik: entry.nik,
      source_sheet: entry.sheetName || '',
      input_nama: inputName,
      nama: '',
      nama_sesuai_nik: '',
      nik_kepala_keluarga: '',
      desil: 'N/A',
      date: new Date().toISOString(),
      status: 'NOT_REGISTERED',
      screenshot: '',
      riwayat_file: this.riwayatFile,
      kk: '',
      kk_sama: entry.kk ? NO_PADAN_DATA_LABEL : '',
      nama_sama: inputName ? NO_PADAN_DATA_LABEL : NO_INPUT_NAME_LABEL,
      id_keluarga: '',
      id_wilayah: '',
      nama_kepala_keluarga: '',
      alamat: '',
      provinsi: '',
      kabupaten: '',
      kecamatan: '',
      kelurahan: '',
      peringkat_nasional: '',
      peringkat_provinsi: '',
      peringkat_kab_kota: '',
      percentile_nasional: '',
      jumlah_anggota_keluarga: '0',
      anggota_keluarga: '',
      pekerjaan_sesuai_nik: '',
      pekerjaan_kepala_keluarga: '',
      status_aktif: '',
      keterangan_deleted: '',
      status_meninggal: '',
      status_kepala_keluarga: '',
      keterangan_deleted_kepala_keluarga: '',
      status_meninggal_kepala_keluarga: '',
      PKH: 'TIDAK',
      SEMBAKO: 'TIDAK',
      PBI: '',
      OKT_DES_2025: 'TIDAK',
      detail_keluarga_json: '{}',
      desil_json: '{}',
      anggota_keluarga_json: '[]',
      error: '',
    };
    this.prevMap.set(entry.nik, 'N/A');
    return result;
  }

  makeDtsenApiResult(entry, family, related, baseStatus) {
    const detail = related.detailKeluarga || {};
    const desil = related.desilDetail || {};
    const anggota = Array.isArray(related.anggotaKeluarga) ? related.anggotaKeluarga : [];
    const inputName = inputNameFromEntry(entry);
    const memberByNik = findMemberByNik(anggota, entry.nik);
    const memberByName = findMemberByName(anggota, inputName);
    const inputMember = memberByNik || memberByName;
    const headMember = findHeadMember(anggota);
    const headMissing = anggota.length > 0 && !headMember;
    const kkNumber = onlyDigits(detail.no_kk || desil.no_kk || family.no_kk || family.NOKK || family.nokk || '');
    const desilText = String(desil.desil_nasional ?? family.desil_nasional ?? family.desil ?? '').trim();
    const detailErrors = [related.detailError, related.desilError, related.anggotaError].filter(Boolean).join(' | ');
    const rawKepalaKeluarga = [
      detail.nama_kepala_keluarga,
      desil.nama_kepala_keluarga,
      family.nama_kepala_keluarga,
      headMember?.nama,
      baseStatus === 'FOUND_BY_KK' ? '' : family.nama,
      baseStatus === 'FOUND_BY_KK' ? '' : family.NAMA,
    ].map(cleanMemberValue).find(Boolean) || '';
    const kepalaKeluarga = headMissing ? NO_HEAD_FAMILY_LABEL : rawKepalaKeluarga;
    const namaSesuaiNik = cleanMemberValue(inputMember?.nama || '')
      || (baseStatus === 'FOUND_BY_KK' ? '' : cleanMemberValue(family.nama || family.NAMA || ''));
    const effectiveHeadMember = headMissing
      ? null
      : (headMember || (namesMatch(namaSesuaiNik, kepalaKeluarga) ? inputMember : null));
    const nikKepalaKeluarga = headMissing ? '' : onlyDigits(
      effectiveHeadMember?.nik
      || detail.nik_kepala_keluarga
      || desil.nik_kepala_keluarga
      || family.nik_kepala_keluarga
      || family.NIK_KEPALA_KELUARGA
      || ''
    );
    const alamat = String(detail.alamat || desil.alamat || family.alamat || '').trim();
    const anggotaSummary = formatAnggotaKeluarga(anggota);
    const result = {
      nik: entry.nik,
      source_sheet: entry.sheetName || '',
      input_nama: inputName,
      nama: namaSesuaiNik || (headMissing ? '' : kepalaKeluarga),
      nama_sesuai_nik: namaSesuaiNik,
      nik_kepala_keluarga: nikKepalaKeluarga,
      desil: desilText,
      date: new Date().toISOString(),
      status: detailErrors ? `PARTIAL:${baseStatus}` : this.statusFor(entry.nik, desilText || 'N/A', baseStatus),
      screenshot: '',
      riwayat_file: this.riwayatFile,
      kk: kkNumber,
      kk_sama: entry.kk ? (kkNumber && onlyDigits(entry.kk) === kkNumber ? 'YA' : 'TIDAK') : '',
      nama_sama: nameMatchAnyLabel(inputName, [
        memberByName?.nama,
        ...anggota.map(member => member?.nama),
        namaSesuaiNik,
        kepalaKeluarga,
      ]),
      id_keluarga: String(family.id_keluarga || detail.id_keluarga || desil.id_keluarga || '').trim(),
      id_wilayah: String(family.id_wilayah || desil.id_wilayah || '').trim(),
      nama_kepala_keluarga: kepalaKeluarga,
      alamat,
      provinsi: String(detail.provinsi || '').trim(),
      kabupaten: String(detail.kabupaten || '').trim(),
      kecamatan: String(detail.kecamatan || '').trim(),
      kelurahan: String(detail.kelurahan || '').trim(),
      peringkat_nasional: valueOrEmpty(desil.peringkat_nasional ?? family.peringkat_nasional),
      peringkat_provinsi: valueOrEmpty(desil.peringkat_provinsi),
      peringkat_kab_kota: valueOrEmpty(desil.peringkat_kab_kota),
      percentile_nasional: valueOrEmpty(desil.percentile_nasional),
      jumlah_anggota_keluarga: String(anggota.length),
      anggota_keluarga: anggotaSummary,
      pekerjaan_sesuai_nik: cleanMemberValue(inputMember?.pekerjaan_utama),
      pekerjaan_kepala_keluarga: cleanMemberValue(effectiveHeadMember?.pekerjaan_utama),
      status_aktif: memberActiveStatus(inputMember),
      keterangan_deleted: memberDeletedNote(inputMember),
      status_meninggal: memberDeathStatus(inputMember),
      status_kepala_keluarga: memberActiveStatus(effectiveHeadMember),
      keterangan_deleted_kepala_keluarga: memberDeletedNote(effectiveHeadMember),
      status_meninggal_kepala_keluarga: memberDeathStatus(effectiveHeadMember),
      PKH: '',
      SEMBAKO: '',
      PBI: '',
      OKT_DES_2025: '',
      error: detailErrors,
      detail_keluarga_json: JSON.stringify(detail),
      desil_json: JSON.stringify(desil),
      anggota_keluarga_json: JSON.stringify(anggota),
    };
    this.prevMap.set(entry.nik, desilText || 'N/A');
    return result;
  }

  statusFor(nik, desilText, baseStatus) {
    const prev = this.prevMap.get(nik) || null;
    if (prev === null) {
      return baseStatus;
    }
    return prev === desilText ? 'UNCHANGED' : `CHANGED:${prev}->${desilText}`;
  }

  async appendArchive(result) {
    const line = [
      result.nik,
      result.source_sheet || '',
      result.nama,
      result.desil,
      result.kk_sama,
      result.alamat || '',
      result.percentile_nasional || '',
      result.jumlah_anggota_keluarga || '',
      result.date,
      result.status,
    ].map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n';
    await fs.appendFile(this.config.archiveFile, line);
  }
}

function createDtsenSearchPayload({ nik = '', nokk = '' }) {
  return {
    no_prop: '',
    no_kab: '',
    no_kec: '',
    no_kel: '',
    page: '0',
    per_page: '10',
    nokk: onlyDigits(nokk),
    nik: onlyDigits(nik),
    nama: '',
    desil: '0',
    statusBansos: '0',
    disabilitas: '-1',
    umur_start: '0',
    umur_end: '0',
  };
}

function isEmptyDtsenResultError(error) {
  return error?.code === 'DTSEN_EMPTY' || /data tidak ditemukan/i.test(String(error?.message || ''));
}

function createSiksSessionExpiredError(message) {
  const error = new Error(String(message || 'Sesi SIKS kedaluwarsa.'));
  error.code = 'SIKS_SESSION_EXPIRED';
  return error;
}

function isSiksSessionExpiredError(error) {
  if (error?.code === 'SIKS_SESSION_EXPIRED') {
    return true;
  }
  return isSiksSessionExpiredMessage(error?.message);
}

function isDtsenSessionExpiredResponse(status, decoded, rawText = '') {
  return status === 401
    || status === 403
    || isSiksSessionExpiredMessage(decoded?.message)
    || isSiksSessionExpiredMessage(decoded?.error)
    || isLoginResponseText(rawText);
}

function isSiksSessionExpiredMessage(message) {
  return /unauthori[sz]ed|forbidden|not authenticated|authentication required|belum login|token.{0,30}(expired|invalid|kedaluwarsa|tidak valid|tidak ditemukan|missing|kosong)|jwt.{0,30}(expired|invalid|kedaluwarsa|tidak valid|tidak ditemukan|missing|kosong)|session.{0,30}(expired|invalid)|sesi.{0,30}(berakhir|habis|kedaluwarsa|tidak valid)|silakan.{0,30}(login|masuk)|login.{0,20}(kembali|ulang)|akses.{0,20}ditolak/i
    .test(String(message || ''));
}

function isLoginResponseText(value) {
  const text = String(value || '');
  return /<html[\s\S]{0,5000}(login|masuk)|name=["']username["']|name=["']password["']|form[\s\S]{0,1000}(login|masuk)/i.test(text);
}

function isLoginUrl(value, configuredLoginUrl = '') {
  let loginPath = '/login';
  try {
    const configuredPath = new URL(configuredLoginUrl).pathname.toLowerCase();
    if (configuredPath && configuredPath !== '/') {
      loginPath = configuredPath;
    }
  } catch {
    // Keep the common /login fallback for custom or incomplete URLs.
  }
  try {
    const currentPath = new URL(String(value || '')).pathname.toLowerCase().replace(/\/+$/, '') || '/';
    const normalizedLoginPath = loginPath.replace(/\/+$/, '') || '/login';
    return currentPath === normalizedLoginPath;
  } catch {
    return String(value || '').toLowerCase().includes(loginPath);
  }
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function valueOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value);
}

function formatAnggotaKeluarga(members) {
  if (!Array.isArray(members) || !members.length) {
    return '';
  }
  return members
    .map((member, index) => formatAnggotaKeluargaItem(member, index))
    .filter(Boolean)
    .join('\n\n');
}

function findMemberByNik(members, nik) {
  const wanted = onlyDigits(nik);
  if (!wanted || !Array.isArray(members)) {
    return null;
  }
  return members.find(member => onlyDigits(member?.nik || '') === wanted) || null;
}

function findMemberByName(members, name) {
  const wanted = normalizeNameForCompare(name);
  if (!wanted || !Array.isArray(members)) {
    return null;
  }
  return members.find(member => normalizeNameForCompare(member?.nama) === wanted) || null;
}

function findHeadMember(members) {
  if (!Array.isArray(members)) {
    return null;
  }
  return members.find(member => {
    const relation = normalizeNameForCompare(member?.hub_kepala_keluarga);
    const relationId = String(member?.id_hub_kepala_keluarga ?? '').trim();
    return relationId === '1' || relation === 'kepala keluarga';
  }) || null;
}

function memberActiveStatus(member) {
  if (!member || typeof member !== 'object') {
    return '';
  }
  const raw = String(member.flag_aktif ?? '').trim();
  if (raw === '0') return 'TIDAK AKTIF';
  if (raw === '1') return 'AKTIF';
  return cleanMemberValue(member.flag_aktif);
}

function memberDeletedNote(member) {
  if (!member || typeof member !== 'object') {
    return '';
  }
  return String(member.flag_aktif ?? '').trim() === '0'
    ? cleanMemberValue(member.keterangan_deleted)
    : '';
}

function memberDeathStatus(member) {
  if (!member || typeof member !== 'object') {
    return '';
  }
  const value = cleanMemberValue(member.status_meninggal);
  if (!value) return '';
  return /^(?:1|ya|yes|true)$/i.test(value) ? 'MENINGGAL' : value;
}

function inputNameFromEntry(entry) {
  const source = entry?.source && typeof entry.source === 'object' ? entry.source : {};
  const candidates = Object.entries(source)
    .map(([key, value]) => ({ key: normalizeTextKey(key), value: String(value ?? '').trim() }))
    .filter(item => item.key.includes('nama') && !/(sheet|alamat|provinsi|kabupaten|kecamatan|kelurahan|desa|komunitas|suku)/.test(item.key))
    .map(item => ({ ...item, priority: nameKeyPriority(item.key) }))
    .sort((a, b) => a.priority - b.priority);
  const bestPriority = candidates[0]?.priority;
  const best = candidates.find(item => item.priority === bestPriority && item.value);
  return best?.value || '';
}

function nameKeyPriority(key) {
  const looseKey = normalizeLooseKey(key);
  if (/(nama lengkap warga|nama warga|nama penduduk|nama penerima|nama anggota|nama kpm|nama pm)/.test(looseKey)) return 0;
  if (/\bnama lengkap\b/.test(looseKey)) return 1;
  if (/\bnama panggilan\b/.test(looseKey)) return 10;
  if (/^nama(?: \d+)?$/.test(looseKey)) return 20;
  return 30;
}

function namesMatch(left, right) {
  const cleanLeft = normalizeNameForCompare(left);
  const cleanRight = normalizeNameForCompare(right);
  return Boolean(cleanLeft && cleanRight && cleanLeft === cleanRight);
}

function nameMatchLabel(left, right) {
  const cleanLeft = normalizeNameForCompare(left);
  if (!cleanLeft) {
    return NO_INPUT_NAME_LABEL;
  }
  const cleanRight = normalizeNameForCompare(right);
  if (!cleanRight) {
    return 'TIDAK';
  }
  return cleanLeft === cleanRight ? 'YA' : 'TIDAK';
}

function nameMatchAnyLabel(left, candidates) {
  const cleanLeft = normalizeNameForCompare(left);
  if (!cleanLeft) {
    return NO_INPUT_NAME_LABEL;
  }
  const names = Array.isArray(candidates) ? candidates : [];
  return names.some(candidate => namesMatch(cleanLeft, candidate)) ? 'YA' : 'TIDAK';
}

function normalizeNameForCompare(value) {
  return normalizeTextKey(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeLooseKey(value) {
  return normalizeTextKey(value)
    .replace(/[._/\\()-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAnggotaKeluargaItem(member, index) {
  if (!member || typeof member !== 'object') {
    return '';
  }

  const name = cleanMemberValue(member.nama) || 'Tanpa nama';
  const lines = [`${index + 1}. ${name}`];
  const fields = [
    ['NIK', onlyDigits(member.nik || '')],
    ['Hubungan', member.hub_kepala_keluarga],
    ['Keberadaan', member.keberadaan_anggota],
    ['Pekerjaan', member.pekerjaan_utama],
    ['Status pekerjaan', member.status_kedudukan_pekerjaan_utama],
    ['Status KPD', member.status_kpd],
    ['Dapodik', member.button_status_dapodik],
    ['Status meninggal', member.status_meninggal],
    ['Keterangan', member.keterangan_deleted],
  ];

  for (const [label, rawValue] of fields) {
    const value = cleanMemberValue(rawValue);
    if (value) {
      lines.push(`   ${label}: ${value}`);
    }
  }

  return lines.join('\n');
}

function cleanMemberValue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text && text !== '-' ? text : '';
}

function isDirectAuthMode(value) {
  return ['direct', 'http', 'api', 'login-direct'].includes(String(value || '').trim().toLowerCase());
}

function siksActionTimeout(config = {}) {
  return Math.max(1000, Number(config.siksActionTimeoutMs || config.pageDefaultTimeoutMs || 0));
}

function siksSearchTimeout(config = {}) {
  return Math.max(1000, Number(config.siksSearchTimeoutMs || config.siksActionTimeoutMs || config.pageDefaultTimeoutMs || 0));
}

function telegramOtpWaitTimeout(config = {}) {
  return Math.max(1000, Number(config.telegramOtpWaitTimeoutMs || config.pageDefaultTimeoutMs || 0));
}

async function extractKKNumber(page, config = {}) {
  return page.evaluate((detailTitleText) => {
    const h2s = Array.from(document.querySelectorAll('h2'));
    for (const h of h2s) {
      const text = (h.textContent || '').trim();
      const match = text.match(/No\s*KK\s*[:\-]\s*([0-9]{8,20})/i);
      if (match) return match[1];
    }
    for (const h of h2s) {
      const text = (h.textContent || '').trim();
      if (detailTitleText && text.includes(detailTitleText)) {
        const match = text.match(/([0-9]{8,20})/);
        if (match) return match[1];
      }
    }
    return null;
  }, config.siksDetailTitleText || '').catch(() => null);
}

async function extractPersonName(page, searchNik) {
  return page.evaluate((nik) => {
    function visiblePrefix(nikText) {
      if (!nikText) return '';
      const match = nikText.match(/^(\d+)/);
      if (match) return match[1];
      return (nikText.split('*')[0] || '').replace(/\D/g, '');
    }

    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim().toUpperCase());
      if (!ths.some(header => header.includes('NIK'))) continue;
      const nameIdx = ths.findIndex(header => header.includes('NAMA'));
      const relIdx = ths.findIndex(header => header.includes('HUBUNGAN') || header.includes('RELASI') || header.includes('STATUS'));
      const rows = Array.from(table.querySelectorAll('tbody tr'));

      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('th,td'));
        const nikCellText = (cells[0]?.innerText || '').trim();
        const visible = visiblePrefix(nikCellText);
        if (visible && nik.startsWith(visible)) {
          return (cells[nameIdx]?.innerText || cells[1]?.innerText || '').trim();
        }
      }

      if (relIdx >= 0) {
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('th,td'));
          const relText = (cells[relIdx]?.innerText || '').toUpperCase();
          if (relText.includes('KEPALA')) {
            return (cells[nameIdx]?.innerText || cells[1]?.innerText || cells[0]?.innerText || '').trim();
          }
        }
      }
      if (rows.length) {
        const cells = Array.from(rows[0].querySelectorAll('th,td'));
        return (cells[nameIdx]?.innerText || cells[1]?.innerText || cells[0]?.innerText || '').trim();
      }
    }

    const all = Array.from(document.querySelectorAll('p,div,span,td,th,label,strong'));
    for (const el of all) {
      const text = (el.innerText || '').trim();
      const match = text.match(/^Nama\s*[:\-]\s*(.+)$/i);
      if (match?.[1]) return match[1].trim();
    }
    const direct = document.querySelector('[data-testid="nama"], .nama, .name');
    if (direct) return (direct.innerText || '').trim();
    const heading = document.querySelector('h3,h2,h4');
    return heading ? (heading.innerText || '').trim() : '';
  }, searchNik).catch(() => '');
}

async function clickRiwayatAndExtract(page, origNik, riwayatFile, config = {}) {
  const result = { pkhHasOKT: false, sembakoHasOKT: false, pbiFlag: '' };
  const actionTimeout = siksActionTimeout(config);
  const pkhTabText = config.siksRiwayatPkhText || '';
  const sembakoTabText = config.siksRiwayatSembakoText || '';
  const pbiTabText = config.siksRiwayatPbiText || '';
  const pkhPeriodText = config.siksPkhPeriodText || '';
  const sembakoPeriodText = config.siksSembakoPeriodText || '';
  const noHistoryText = config.siksNoRiwayatText || '';
  await clickExactText(page, config.siksRiwayatText || '').catch(() => {});

  const waitForPeriodeOrNoHistory = async () => page.waitForFunction(() => {
    const hasPeriode = Array.from(document.querySelectorAll('th[scope="col"]')).some(th => (th.textContent || '').trim() === 'Periode');
    const hasAlert = Array.from(document.querySelectorAll('div.MuiAlert-message')).some(div => (div.textContent || '').trim().length > 0);
    return hasPeriode || hasAlert;
  }, { timeout: actionTimeout }).then(() => true).catch(() => false);

  const pkhClicked = await clickButtonContaining(page, pkhTabText);
  if (pkhClicked && await waitForPeriodeOrNoHistory()) {
    const noHistory = await page.$eval('div.MuiAlert-message', el => el.innerText).catch(() => null);
    if (!(noHistory && noHistoryText && noHistory.includes(noHistoryText))) {
      result.pkhHasOKT = await page.evaluate((periodText) => Boolean(periodText) && Array.from(document.querySelectorAll('tbody.MuiTableBody-root tr')).some(tr => (tr.innerText || '').includes(periodText)), pkhPeriodText).catch(() => false);
      if (result.pkhHasOKT) {
        await appendJsonl(riwayatFile, { nik: origNik, section: pkhTabText, found: pkhPeriodText, ts: new Date().toISOString() });
      }
    }
  }

  const sembakoClicked = await clickButtonContaining(page, sembakoTabText);
  if (sembakoClicked && await waitForPeriodeOrNoHistory()) {
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('tbody.MuiTableBody-root tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim()))).catch(() => []);
    if (rows.length) {
      result.sembakoHasOKT = Boolean(sembakoPeriodText) && rows.some(row => row.join(' ').includes(sembakoPeriodText));
      await appendJsonl(riwayatFile, { nik: origNik, section: sembakoTabText, rows, ts: new Date().toISOString() });
    }
  }

  const pbiClicked = await clickButtonContaining(page, pbiTabText);
  if (pbiClicked) {
    const loaded = await page.waitForFunction(() => Array.from(document.querySelectorAll('th')).some(th => (th.textContent || '').trim() === 'Periode Awal'), { timeout: actionTimeout }).then(() => true).catch(async () => {
      return page.waitForSelector('tbody.MuiTableBody-root tr', { timeout: actionTimeout }).then(() => true).catch(() => false);
    });
    if (loaded) {
      const match = await page.evaluate(({ programText, startYear, endYear, endMonths }) => {
        const rows = Array.from(document.querySelectorAll('tbody.MuiTableBody-root tr'));
        for (const tr of rows) {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 3) continue;
          const awal = (tds[1].innerText || '').toUpperCase();
          const akhir = (tds[2].innerText || '').toUpperCase();
          const program = String(programText || '').toUpperCase();
          const months = Array.isArray(endMonths) ? endMonths.map(month => String(month || '').toUpperCase()).filter(Boolean) : [];
          if (!program || !startYear || !endYear || !months.length) {
            continue;
          }
          if (awal.includes(program) && awal.includes(String(startYear || '')) && akhir.includes(program) && months.some(month => akhir.includes(month)) && akhir.includes(String(endYear || ''))) {
            return { awal: awal.trim(), akhir: akhir.trim() };
          }
        }
        return null;
      }, {
        programText: config.siksPbiProgramText || '',
        startYear: config.siksPbiStartYear || '',
        endYear: config.siksPbiEndYear || '',
        endMonths: config.siksPbiEndMonths || [],
      }).catch(() => null);
      if (match) {
        result.pbiFlag = config.siksPbiFlagValue || '';
        await appendJsonl(riwayatFile, { nik: origNik, section: pbiTabText, match, ts: new Date().toISOString() });
      }
    }
  }

  return result;
}

async function closeDetailIfVisible(page, config = {}) {
  const selector = config.siksSelectors?.detailCloseButton || '';
  if (!selector) return;
  const closeBtn = await page.$(selector);
  if (!closeBtn) return;
  const visible = await page.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }, closeBtn).catch(() => false);
  if (visible) {
    await closeBtn.click().catch(() => {});
  }
}

async function clickExactText(page, text) {
  if (!text) {
    return false;
  }
  return page.evaluate((targetText) => {
    const target = Array.from(document.querySelectorAll('button, a, span, div, p'))
      .find(el => (el.innerText || '').trim() === targetText);
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, text);
}

async function clickButtonContaining(page, text) {
  if (!text) {
    return false;
  }
  return page.evaluate((needle) => {
    const target = Array.from(document.querySelectorAll('button')).find(btn => (btn.innerText || '').includes(needle));
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, text).catch(() => false);
}

async function clearAndType(page, selector, value) {
  await page.$eval(selector, el => { el.value = ''; }).catch(() => {});
  await page.type(selector, value, { delay: 40 });
}

async function hasOtpInputs(page, selector = 'div.MuiOtpInput-Box input') {
  return page.$(selector).then(Boolean).catch(() => false);
}

async function clearOtpInputs(page, selector = 'div.MuiOtpInput-Box input') {
  const inputs = await page.$$(selector);
  for (const input of inputs) {
    await input.focus().catch(() => {});
    await page.keyboard.down('Control').catch(() => {});
    await page.keyboard.press('A').catch(() => {});
    await page.keyboard.up('Control').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
  }
  await page.$$eval(selector, elements => {
    for (const element of elements) {
      if (element.value !== '') {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }).catch(() => {});
}

async function scrollTelegramChatToBottom(page, messageSelector, config = {}) {
  const scrollAttempts = Math.max(1, Number(config.telegramScrollAttempts || 1));
  const settleAttempts = Math.max(1, Number(config.telegramSettleScrollAttempts || 1));
  for (let attempt = 1; attempt <= scrollAttempts; attempt += 1) {
    await page.evaluate(selector => {
      const messages = Array.from(document.querySelectorAll(selector));
      const scrollables = [];
      const addScrollable = element => {
        if (!element || scrollables.includes(element)) {
          return;
        }
        if (element.scrollHeight > element.clientHeight + 24) {
          scrollables.push(element);
        }
      };

      for (const message of messages) {
        let current = message.parentElement;
        for (let depth = 0; current && depth < 10; depth += 1) {
          addScrollable(current);
          current = current.parentElement;
        }
      }

      const target = scrollables.sort((a, b) => {
        const aScrollable = a.scrollHeight - a.clientHeight;
        const bScrollable = b.scrollHeight - b.clientHeight;
        return bScrollable - aScrollable;
      })[0];
      if (target) {
        target.scrollTop = target.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }, messageSelector).catch(() => {});

    await page.keyboard.press('End').catch(() => {});
    await clickTelegramGoToBottomButton(page, config);
    await sleep(350);
  }

  for (let attempt = 1; attempt <= settleAttempts; attempt += 1) {
    await clickTelegramGoToBottomButton(page, config);
    await page.keyboard.press('End').catch(() => {});
    await page.evaluate(() => {
      const scrollables = Array.from(document.querySelectorAll('*'))
        .filter(el => el.scrollHeight > el.clientHeight + 24)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      for (const el of scrollables.slice(0, 3)) {
        el.scrollTop = el.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(250);
  }
}

async function clickTelegramGoToBottomButton(page, config = {}) {
  return page.evaluate(({ selector, labels }) => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [];
    if (selector) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          candidates.push(element);
        }
      } catch {
        // Continue with text/aria discovery when an override selector is stale.
      }
    }
    for (const element of document.querySelectorAll('button, [role="button"], [aria-label], [title]')) {
      const text = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-tooltip'),
        element.innerText,
        element.textContent,
      ].filter(Boolean).join(' ').toLowerCase();
      if ((labels || []).some(label => text.includes(String(label).toLowerCase()))) {
        candidates.push(element);
      }
    }
    const target = candidates.find(visible);
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: 'center', inline: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    target.click();
    return true;
  }, {
    selector: config.telegramGoToBottomSelector || '',
    labels: config.telegramGoToBottomTexts || [],
  }).catch(() => false);
}

async function readBottomOtpMessage(page, messageSelector, config = {}) {
  return page.$$eval(messageSelector, (elements, otpPrefix) => {
    const normalizedPrefix = String(otpPrefix || '').toLowerCase();
    const messages = elements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || '').trim();
        return { text, bottom: rect.bottom, top: rect.top, index };
      })
      .filter(item => item.text.toLowerCase().includes(normalizedPrefix));

    messages.sort((a, b) => b.index - a.index || b.bottom - a.bottom || b.top - a.top);

    return messages[0]?.text || '';
  }, config.telegramOtpPrefix || '').catch(() => '');
}

function matchOtpFromMessage(message, prefix = '') {
  if (!prefix) {
    return '';
  }
  const pattern = String(prefix)
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s*');
  const match = String(message || '').match(new RegExp(`${pattern}\\s*([A-Z0-9]{6,8})`, 'i'));
  return match ? match[1].toUpperCase() : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickOtpValidationButton(page, config = {}) {
  const explicitSelectors = Array.isArray(config.siksOtpValidationSelectors) && config.siksOtpValidationSelectors.length
    ? config.siksOtpValidationSelectors
    : [];

  for (const selector of explicitSelectors) {
    const clicked = await page.click(selector).then(() => true).catch(() => false);
    if (clicked) {
      return true;
    }
  }

  const clickedByText = await page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const preferred = buttons.find(btn => /proses\s*validasi|validasi|verifikasi|lanjut|kirim|submit|masuk|login/i.test(btn.innerText || btn.textContent || ''));
    const fallback = buttons.length === 1 ? buttons[0] : null;
    const target = preferred || fallback;
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }).catch(() => false);

  if (!clickedByText) {
    throw new Error('Tombol validasi OTP tidak ditemukan setelah kode OTP diisi.');
  }
  return true;
}

async function waitAfterOtpValidation(page, config) {
  const timeout = Math.max(3000, Number(config.pageDefaultTimeoutMs || 30000));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(({ otpInputs, arrowText, dtsenMenuText, alertDialog }) => {
      const hasOtp = Boolean(document.querySelector(otpInputs));
      const hasMenu = Array.from(document.querySelectorAll('span')).some(span => span.textContent.trim() === arrowText);
      const hasDtsen = Array.from(document.querySelectorAll('p')).some(el => el.textContent.trim() === dtsenMenuText);
      const alertSelectors = [alertDialog, '[role="alert"]', '.MuiAlert-message', '.MuiSnackbar-root'].filter(Boolean);
      const alerts = alertSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));
      const errorText = alerts.map(element => (element.innerText || element.textContent || '').trim()).filter(Boolean).join(' | ');
      const body = document.body?.innerText || '';
      const success = hasMenu || hasDtsen || (!hasOtp && /dashboard|beranda|view dtsen/i.test(body));
      const otpRelated = /otp|kode|validasi|verifikasi/i.test(errorText);
      const failureRelated = /salah|gagal|tidak sesuai|tidak valid|kedaluwarsa|expired|ditolak/i.test(errorText);
      const rejected = otpRelated && failureRelated;
      return { hasOtp, success, rejected, errorText };
    }, {
      otpInputs: config.siksSelectors?.otpInputs || 'div.MuiOtpInput-Box input',
      arrowText: config.siksMenuArrowText || 'arrow_right',
      dtsenMenuText: config.siksDtsenMenuText || 'View DTSEN',
      alertDialog: config.siksSelectors?.alertDialog || 'p#alert-dialog-description',
    }).catch(() => ({ hasOtp: true, success: false, rejected: false, errorText: '' }));
    if (state.rejected) {
      return { success: false, errorText: state.errorText };
    }
    if (state.success || !state.hasOtp) {
      return { success: true, errorText: '' };
    }
    await sleep(500);
  }
  const stillHasOtp = await hasOtpInputs(page, config.siksSelectors?.otpInputs);
  return {
    success: !stillHasOtp,
    errorText: stillHasOtp ? 'Form OTP masih tampil setelah validasi.' : '',
  };
}

function samePageUrl(left, right) {
  try {
    const a = new URL(String(left || ''));
    const b = new URL(String(right || ''));
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return String(left || '') === String(right || '');
  }
}

function matchesAnyUrlHost(url, hosts = []) {
  const haystack = String(url || '').toLowerCase();
  return (Array.isArray(hosts) ? hosts : [hosts]).some(host => {
    const pattern = String(host || '').trim().toLowerCase();
    if (!pattern) {
      return false;
    }
    if (pattern.includes('://')) {
      try {
        return new URL(url).hostname === new URL(pattern).hostname;
      } catch {
        return haystack.includes(pattern);
      }
    }
    return haystack.includes(pattern);
  });
}

async function clickFirstButton(page) {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const preferred = buttons.find(btn => /masuk|login|lanjut|kirim|submit/i.test(btn.innerText || '')) || buttons[0];
    if (preferred) preferred.click();
  });
}

async function appendJsonl(filePath, data) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`);
}

function loadPreviousResults(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) {
    return map;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3 && /^\d+$/.test(parts[0])) {
      map.set(parts[0], parts[2]);
    }
  }
  return map;
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Math.max(0, Number(timeoutMs || 0));
  if (!ms) {
    return promise;
  }
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
