import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'path';
import { getCaptchaTextFromGemini } from './captchaSolver.js';
import { fetchWithTimeout } from './httpClient.js';
import { readOtpFromTelegram } from '../login-direct/telegram-otp.js';

const DEFAULT_AUTH_BASE = 'https://api.kemensos.go.id';
const DEFAULT_AUTH_APP_KEY = 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=';

export async function loginDirectSiks(config = {}, options = {}) {
  const client = new SiksDirectAuthClient(config, options);
  return client.login(options);
}

export class SiksDirectAuthClient {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.baseUrl = trimSlash(options.baseUrl || config.siksAuthApiBaseUrl || DEFAULT_AUTH_BASE);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || config.siksActionTimeoutMs || 15000));
    this.usernameField = options.usernameField || config.siksHttpLoginUsernameField || 'email';
    this.appKey = options.appKey || config.siksAuthAppKey || config.dtsenAppKey || DEFAULT_AUTH_APP_KEY;
    this.jobDir = options.jobDir || '';
    this.logDir = options.logDir || path.join(this.jobDir || '.siks', 'auth-direct');
    this.endpoints = {
      login: options.loginEndpoint || config.siksAuthLoginEndpoint || '/siks/auth/v1/login',
      captcha: options.captchaEndpoint || config.siksAuthCaptchaEndpoint || '/siks/auth/v1/get-captcha',
      matchingOtp: options.matchingOtpEndpoint || config.siksAuthMatchingOtpEndpoint || '/siks/auth/v1/matching-otp',
      resendOtp: options.resendOtpEndpoint || config.siksAuthResendOtpEndpoint || '/siks/auth/v1/resend-otp',
      profile: options.profileEndpoint || config.siksAuthProfileEndpoint || '/siks/auth/v1/get-profile',
    };
  }

  async login({ reason = 'direct auth' } = {}) {
    const username = this.config.siksUsername || '';
    const password = this.config.siksPassword || '';
    if (!username || !password) {
      throw new Error('SIKS_USERNAME dan SIKS_PASSWORD wajib diisi untuk auth direct.');
    }

    const maxCaptchaAttempts = Math.max(1, Number(this.config.siksCaptchaAttempts || 1));
    let lastError = null;
    for (let attempt = 1; attempt <= maxCaptchaAttempts; attempt += 1) {
      try {
        const loginStartedAt = new Date();
        const captchaResponse = await this.getCaptcha();
        const captchaData = unwrapAuthData(captchaResponse);
        const captcha = await this.solveCaptcha(captchaData, attempt);
        const payload = this.loginPayload({ username, password, captcha, captchaData });
        const login = await this.requestAuth('POST', this.endpoints.login, {
          body: this.toEncryptedFormData(payload),
          requestFields: payload,
          logName: `login-${attempt}`,
        });
        const loginData = unwrapAuthData(login);
        const authorization = extractAuthorization(loginData);
        if (authorization) {
          return await this.finishLogin({ authorization, loginData, reason, method: 'direct-login' });
        }

        if (isOtpRequired(loginData)) {
          const otpStageToken = extractOtpStageToken(loginData);
          const otpAuthorization = await this.completeOtp({
            username,
            loginStartedAt,
            otpStageToken,
          });
          return await this.finishLogin({ authorization: otpAuthorization, loginData, reason, method: 'direct-otp' });
        }

        const message = authMessage(login, loginData) || 'Token authorization tidak ditemukan di respons login direct.';
        lastError = new Error(message);
        if (!isCaptchaOrLoginRetryable(message) || attempt >= maxCaptchaAttempts) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        if (!isCaptchaOrLoginRetryable(error.message) || attempt >= maxCaptchaAttempts) {
          break;
        }
      }
    }

    throw new Error(`Login SIKS direct gagal setelah ${maxCaptchaAttempts} percobaan captcha. ${lastError?.message || ''}`.trim());
  }

  async finishLogin({ authorization, loginData, reason, method }) {
    const profile = await this.getProfile(authorization).catch(error => ({
      warning: `Profile check gagal: ${error.message}`,
    }));
    await this.writeJsonLog('login-success', {
      reason,
      method,
      login: loginData,
      profile,
      authorization,
    });
    return {
      authorization,
      profile,
      source: 'direct',
      method,
      loggedInAt: new Date().toISOString(),
    };
  }

  async completeOtp({ username, loginStartedAt, otpStageToken }) {
    if (!otpStageToken) {
      throw new Error('SIKS meminta OTP, tetapi token tahap OTP tidak ditemukan di respons login.');
    }

    const attemptedOtps = new Set();
    const maxAttempts = Math.max(1, Number(this.config.siksOtpSubmitAttempts || 1));
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const otp = await this.readOtp({ since: loginStartedAt, excludedOtps: attemptedOtps });
      if (!otp) {
        throw new Error(`OTP baru tidak ditemukan dari Telegram setelah ${attemptedOtps.size} kode sebelumnya ditolak.`);
      }
      attemptedOtps.add(otp);

      try {
        const payload = {
          username,
          email: username,
          otp,
          type: 'sendotp',
        };
        const response = await this.requestAuth('POST', this.endpoints.matchingOtp, {
          token: otpStageToken,
          body: this.toEncryptedFormData(payload),
          requestFields: payload,
          logName: `otp-${attempt}`,
        });
        const data = unwrapAuthData(response);
        const authorization = extractAuthorization(data);
        if (authorization) {
          return authorization;
        }
        lastError = new Error(authMessage(response, data) || 'OTP diterima tanpa token authorization.');
        if (!isOtpRetryable(lastError.message)) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        if (!isOtpRetryable(error.message) || attempt >= maxAttempts) {
          break;
        }
      }

      await sleep(Math.max(250, Number(this.config.siksOtpRetryDelayMs || 1000)));
    }

    throw new Error(`Login SIKS direct gagal setelah ${maxAttempts} percobaan OTP. ${lastError?.message || ''}`.trim());
  }

  async readOtp({ since, excludedOtps = new Set() } = {}) {
    const manualOtp = String(this.config.siksDirectOtp || process.env.SIKS_HTTP_LOGIN_OTP || process.env.SIKS_OTP || '').trim();
    if (manualOtp && !excludedOtps.has(manualOtp)) {
      return manualOtp;
    }

    return await readOtpFromTelegram({ since, excludedOtps });
  }

  async getCaptcha() {
    return this.requestAuth('GET', this.endpoints.captcha, {
      logName: 'captcha',
    });
  }

  async solveCaptcha(captchaData, attempt = 1) {
    const manualCaptcha = String(this.config.siksDirectCaptchaText || process.env.SIKS_HTTP_LOGIN_CAPTCHA || process.env.SIKS_CAPTCHA_TEXT || '').trim();
    const { buffer, extension } = await this.captchaImageBuffer(captchaData);
    await fs.ensureDir(this.logDir);
    const imagePath = path.join(this.logDir, `captcha-${attempt}.${extension || 'png'}`);
    await fs.writeFile(imagePath, buffer);
    if (manualCaptcha) {
      await this.writeJsonLog(`captcha-solve-${attempt}`, {
        mode: 'manual',
        imagePath,
        captcha: manualCaptcha,
      });
      return manualCaptcha.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    const captcha = await getCaptchaTextFromGemini(imagePath, this.config);
    await this.writeJsonLog(`captcha-solve-${attempt}`, {
      mode: 'gemini',
      imagePath,
      captcha,
    });
    return captcha;
  }

  async captchaImageBuffer(captchaData) {
    const image = findCaptchaImage(captchaData);
    if (!image) {
      await this.writeJsonLog('captcha-missing-image', { captchaData });
      throw new Error('Response captcha SIKS tidak memuat gambar yang bisa dibaca.');
    }

    if (image.startsWith('data:image/')) {
      const [, mime, b64] = image.match(/^data:(image\/[^;]+);base64,(.+)$/) || [];
      if (!b64) {
        throw new Error('Format data URI captcha tidak valid.');
      }
      return {
        buffer: Buffer.from(b64, 'base64'),
        extension: extensionFromMime(mime),
      };
    }

    if (/^https?:\/\//i.test(image) || image.startsWith('/')) {
      const url = new URL(image, `${this.baseUrl}/`).toString();
      const response = await fetchWithTimeout(url, {
        headers: this.browserLikeHeaders(),
      }, {
        timeoutMs: this.timeoutMs,
        timeoutMessage: `Download captcha timeout setelah ${Math.round(this.timeoutMs / 1000)} detik.`,
      });
      if (!response.ok) {
        throw new Error(`Download captcha HTTP ${response.status}.`);
      }
      const contentType = response.headers.get('content-type') || '';
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        extension: extensionFromMime(contentType),
      };
    }

    if (/^[A-Za-z0-9+/=\s]+$/.test(image) && image.replace(/\s+/g, '').length > 30) {
      return {
        buffer: Buffer.from(image.replace(/\s+/g, ''), 'base64'),
        extension: 'png',
      };
    }

    await this.writeJsonLog('captcha-unknown-image', { image });
    throw new Error('Format gambar captcha SIKS tidak dikenali.');
  }

  loginPayload({ username, password, captcha, captchaData }) {
    const payload = {
      [this.usernameField]: username,
      password,
      captcha,
      key: captchaKey(captchaData),
    };
    if (this.usernameField !== 'email') {
      payload.email = username;
    }
    return payload;
  }

  async getProfile(token) {
    return this.requestAuth('GET', this.endpoints.profile, {
      token,
      logName: 'profile',
    });
  }

  async requestAuth(method, endpoint, { token = '', body = null, requestFields = null, logName = '' } = {}) {
    const url = endpointUrl(this.baseUrl, endpoint);
    if (logName) {
      await this.writeJsonLog(`${logName}-request`, {
        method,
        url,
        headers: token ? { authorization: token } : {},
        fields: requestFields,
      });
    }

    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        ...this.browserLikeHeaders(),
        ...(token ? { authorization: token } : {}),
      },
      body,
    }, {
      timeoutMs: this.timeoutMs,
      timeoutMessage: `SIKS auth API timeout setelah ${Math.round(this.timeoutMs / 1000)} detik.`,
    });

    const text = await response.text().catch(() => '');
    const parsed = parseJson(text);
    const data = parsed && typeof parsed === 'object'
      ? decodeAuthResponse(parsed, this.appKey)
      : (parsed ?? text);

    if (logName) {
      await this.writeJsonLog(`${logName}-response`, {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: data,
      });
    }

    if (!response.ok) {
      throw new Error(authMessage(data) || `SIKS auth API HTTP ${response.status}`);
    }
    return data;
  }

  toEncryptedFormData(fields) {
    const form = new FormData();
    form.append('entity', encryptAuthPayload(JSON.stringify(fields), this.appKey));
    return form;
  }

  browserLikeHeaders() {
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      origin: this.config.siksOrigin || this.config.siksBaseUrl || 'https://siks.kemensos.go.id',
      referer: this.config.siksLoginUrl || 'https://siks.kemensos.go.id/login',
      'user-agent': this.config.siksUserAgent || 'Mozilla/5.0 KAT-Worker-DirectAuth/1.0',
    };
  }

  async writeJsonLog(name, data) {
    await fs.ensureDir(this.logDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeJson(path.join(this.logDir, `${stamp}-${name}.json`), sanitizeForLog(data), { spaces: 2 });
  }
}

function encryptAuthPayload(plaintext, appKey) {
  const key = authKey(appKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}

function decryptAuthPayload(ciphertext, appKey) {
  const raw = Buffer.from(String(ciphertext || ''), 'base64');
  if (raw.length < 28) {
    throw new Error('Ciphertext auth SIKS terlalu pendek untuk AES-GCM.');
  }

  const key = authKey(appKey);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function decodeAuthResponse(json, appKey) {
  if (json && typeof json.data === 'string') {
    const decrypted = tryDecryptAuthPayload(json.data, appKey);
    if (decrypted !== null) {
      return { ...json, data: parseJson(decrypted) ?? decrypted };
    }
  }
  return json;
}

function tryDecryptAuthPayload(ciphertext, appKey) {
  try {
    return decryptAuthPayload(ciphertext, appKey);
  } catch {
    return null;
  }
}

function authKey(appKey) {
  const key = Buffer.from(String(appKey || DEFAULT_AUTH_APP_KEY).replace(/^base64:/, ''), 'base64');
  if (key.length !== 32) {
    throw new Error('SIKS auth app key harus berupa base64 key 32 byte.');
  }
  return key;
}

function unwrapAuthData(data) {
  if (data?.data?.data !== undefined) {
    return data.data.data;
  }
  if (data?.data !== undefined) {
    return data.data;
  }
  return data;
}

function extractAuthorization(data) {
  const candidates = [
    data?.authorization,
    data?.Authorization,
    data?.token,
    data?.access_token,
    data?.bearer_token,
    data?.data?.token,
    data?.data?.access_token,
    data?.data?.data?.token,
    data?.data?.data?.access_token,
  ];
  return candidates
    .map(value => String(value || '').trim())
    .find(value => value.startsWith('Bearer ') || value.length > 40) || '';
}

function isOtpRequired(data) {
  return String(data?.code || '').toLowerCase() === 'otp_req'
    || String(data?.jenis_autentikasi || data?.auth_type || '').toLowerCase().includes('otp');
}

function extractOtpStageToken(data) {
  if (typeof data?.data === 'string') {
    return data.data.trim();
  }
  return extractAuthorization(data?.data)
    || String(data?.token || data?.access_token || data?.otp_token || data?.session_token || '').trim();
}

function findCaptchaImage(value) {
  const direct = [
    value?.captcha,
    value?.image,
    value?.img,
    value?.base64,
    value?.url,
    value?.data?.captcha,
    value?.data?.image,
    value?.data?.img,
    value?.data?.base64,
    value?.data?.url,
  ].filter(Boolean);
  const candidates = [...direct, ...collectStrings(value)];
  return candidates.find(candidate => isLikelyCaptchaImage(candidate)) || '';
}

function isLikelyCaptchaImage(value) {
  const text = String(value || '').trim();
  if (text.length <= 30) return false;
  if (text.startsWith('data:image/')) return true;
  if (/^https?:\/\//i.test(text) || text.startsWith('/')) return true;
  return /^[A-Za-z0-9+/=\s]+$/.test(text);
}

function captchaKey(data) {
  return String(
    data?.key
    || data?.captcha_key
    || data?.captchaKey
    || data?.id
    || data?.uuid
    || data?.token
    || data?.data?.key
    || data?.data?.captcha_key
    || data?.data?.id
    || ''
  ).trim();
}

function authMessage(...items) {
  const messages = [];
  for (const item of items) {
    collectMessages(item, messages);
  }
  return messages.find(Boolean) || '';
}

function collectMessages(value, out, seen = new Set()) {
  if (!value || seen.has(value)) return;
  if (typeof value !== 'object') return;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (['message', 'error', 'detail', 'description'].includes(key.toLowerCase()) && typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      collectMessages(item, out, seen);
    }
  }
}

function isCaptchaOrLoginRetryable(message) {
  const text = String(message || '').toLowerCase();
  return !text
    || text.includes('captcha')
    || text.includes('login gagal')
    || text.includes('kode keamanan')
    || text.includes('token authorization tidak ditemukan');
}

function isOtpRetryable(message) {
  const text = String(message || '').toLowerCase();
  return !text
    || text.includes('otp')
    || text.includes('invalid')
    || text.includes('tidak valid')
    || text.includes('salah')
    || text.includes('expired')
    || text.includes('kedaluwarsa')
    || text.includes('token authorization tidak ditemukan');
}

function collectStrings(value, out = [], seen = new Set()) {
  if (!value || seen.has(value)) {
    return out;
  }
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value !== 'object') {
    return out;
  }
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, out, seen);
  }
  return out;
}

function sanitizeForLog(value) {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|authorization|access_token|token|otp|api_hash/i.test(key)) {
      out[key] = item ? '[redacted]' : item;
      continue;
    }
    out[key] = sanitizeForLog(item);
  }
  return out;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function endpointUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(String(endpoint || ''))) {
    return String(endpoint);
  }
  return `${trimSlash(baseUrl)}/${String(endpoint || '').replace(/^\/+/, '')}`;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function extensionFromMime(mime = '') {
  const text = String(mime).toLowerCase();
  if (text.includes('jpeg') || text.includes('jpg')) return 'jpg';
  if (text.includes('webp')) return 'webp';
  if (text.includes('gif')) return 'gif';
  return 'png';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
