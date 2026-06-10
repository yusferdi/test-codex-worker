import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export function loadEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readConfig() {
  const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cwd = path.resolve(process.cwd());
  loadEnv(path.resolve(cwd, '.env'));
  loadEnv(path.resolve(cwd, '.env.local'));
  if (cwd !== workerRoot) {
    loadEnv(path.resolve(workerRoot, '.env'));
    loadEnv(path.resolve(workerRoot, '.env.local'));
  }
  const args = new Set(process.argv.slice(2));
  const cliAuthMode = args.has('--direct')
    ? 'direct'
    : (argValue(process.argv.slice(2), '--auth-mode') || argValue(process.argv.slice(2), '--siks-auth-mode') || null);
  const cliLogLevel = args.has('--verbose') ? 'verbose' : (args.has('--clean') ? 'clean' : null);
  const requestedLogLevel = String(cliLogLevel || process.env.LOG_LEVEL || 'clean').toLowerCase();
  const legacyPollIntervalMs = numberEnv('POLL_INTERVAL_MS', 10000);
  const siksBaseUrl = trimSlash(process.env.SIKS_BASE_URL || 'https://siks.kemensos.go.id');
  const geminiModel = process.env.GEMINI_API_MODEL || 'gemini-2.5-flash';
  return {
    apiBaseUrl: trimSlash(process.env.API_BASE_URL || 'http://localhost:8000/api'),
    workerApiKey: process.env.WORKER_API_KEY || '',
    workerName: process.env.WORKER_NAME || os.hostname(),
    pollIntervalMs: legacyPollIntervalMs,
    idlePollIntervalMs: numberEnv('IDLE_POLL_INTERVAL_MS', legacyPollIntervalMs),
    idlePollMaxIntervalMs: numberEnv('IDLE_POLL_MAX_INTERVAL_MS', legacyPollIntervalMs),
    idlePollBackoffFactor: numberEnv('IDLE_POLL_BACKOFF_FACTOR', 1.5),
    loopErrorBackoffMs: numberEnv('LOOP_ERROR_BACKOFF_MS', legacyPollIntervalMs),
    heartbeatIntervalMs: numberEnv('HEARTBEAT_INTERVAL_MS', 20000),
    jobTimeoutMs: numberEnv('JOB_TIMEOUT_MS', 1800000),
    jobTimeoutGraceMs: numberEnv('JOB_TIMEOUT_GRACE_MS', 600000),
    maxTimeoutExtensions: numberEnv('MAX_TIMEOUT_EXTENSIONS', 3),
    browserRestartAttempts: numberEnv('BROWSER_RESTART_ATTEMPTS', 2),
    browserLaunchTimeoutMs: numberEnv('BROWSER_LAUNCH_TIMEOUT_MS', 60000),
    browserCloseTimeoutMs: numberEnv('BROWSER_CLOSE_TIMEOUT_MS', 15000),
    pageDefaultTimeoutMs: numberEnv('PAGE_DEFAULT_TIMEOUT_MS', 30000),
    siksActionTimeoutMs: numberEnv('SIKS_ACTION_TIMEOUT_MS', 10000),
    siksSearchTimeoutMs: numberEnv('SIKS_SEARCH_TIMEOUT_MS', 15000),
    siksCaptchaAttempts: numberEnv('SIKS_CAPTCHA_ATTEMPTS', 5),
    siksSessionProbeIntervalMs: numberEnv('SIKS_SESSION_PROBE_INTERVAL_MS', 120000),
    siksSessionSettleMs: numberEnv('SIKS_SESSION_SETTLE_MS', 2000),
    siksSessionRecoveryAttempts: numberEnv('SIKS_SESSION_RECOVERY_ATTEMPTS', 2),
    siksSessionRecoveryDelayMs: numberEnv('SIKS_SESSION_RECOVERY_DELAY_MS', 1500),
    siksClearAuthStateOnRecovery: boolEnv('SIKS_CLEAR_AUTH_STATE_ON_RECOVERY', true),
    rowTimeoutMs: numberEnv('ROW_TIMEOUT_MS', 300000),
    rowRetryAttempts: numberEnv('ROW_RETRY_ATTEMPTS', 2),
    rowErrorRecheckAttempts: numberEnv('ROW_ERROR_RECHECK_ATTEMPTS', 2),
    rowErrorRecheckDelayMs: numberEnv('ROW_ERROR_RECHECK_DELAY_MS', 1500),
    recheckErrorRowsBeforeComplete: boolEnv('RECHECK_ERROR_ROWS_BEFORE_COMPLETE', true),
    maxConsecutiveRowErrors: numberEnv('MAX_CONSECUTIVE_ROW_ERRORS', 30),
    resumePartialResults: boolEnv('RESUME_PARTIAL_RESULTS', true),
    requeueOnShutdown: boolEnv('REQUEUE_ON_SHUTDOWN', true),
    apiRequestTimeoutMs: numberEnv('API_REQUEST_TIMEOUT_MS', 60000),
    apiRetryAttempts: numberEnv('API_RETRY_ATTEMPTS', 3),
    apiRetryDelayMs: numberEnv('API_RETRY_DELAY_MS', 1500),
    apiFallbackDir: process.env.API_FALLBACK_DIR || './output/api-fallback',
    progressLogEvery: numberEnv('PROGRESS_LOG_EVERY', 25),
    progressUpdateEvery: numberEnv('PROGRESS_UPDATE_EVERY', 5),
    progressUpdateIntervalMs: numberEnv('PROGRESS_UPDATE_INTERVAL_MS', 5000),
    logLevel: requestedLogLevel === 'verbose' ? 'verbose' : 'clean',
    runOnce: boolEnv('RUN_ONCE', false),
    maxJobsPerRun: numberEnv('MAX_JOBS_PER_RUN', 0),
    outputRetentionDays: numberEnv('OUTPUT_RETENTION_DAYS', 14),
    outputCleanupIntervalMs: numberEnv('OUTPUT_CLEANUP_INTERVAL_MS', 3600000),
    chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    headless: boolEnv('HEADLESS', false),
    keepBrowserOpen: boolEnv('KEEP_BROWSER_OPEN', true),
    leaveBrowserOpenOnExit: boolEnv('LEAVE_BROWSER_OPEN_ON_EXIT', false),
    siksUserDataDir: process.env.SIKS_USER_DATA_DIR || './session-data',
    siksAuthMode: cliAuthMode || process.env.SIKS_AUTH_MODE || 'puppeteer',
    siksAuthApiBaseUrl: trimSlash(process.env.SIKS_AUTH_API_BASE_URL || 'https://api.kemensos.go.id'),
    siksAuthLoginEndpoint: process.env.SIKS_AUTH_LOGIN_ENDPOINT || '/siks/auth/v1/login',
    siksAuthCaptchaEndpoint: process.env.SIKS_AUTH_CAPTCHA_ENDPOINT || '/siks/auth/v1/get-captcha',
    siksAuthMatchingOtpEndpoint: process.env.SIKS_AUTH_MATCHING_OTP_ENDPOINT || '/siks/auth/v1/matching-otp',
    siksAuthResendOtpEndpoint: process.env.SIKS_AUTH_RESEND_OTP_ENDPOINT || '/siks/auth/v1/resend-otp',
    siksAuthProfileEndpoint: process.env.SIKS_AUTH_PROFILE_ENDPOINT || '/siks/auth/v1/get-profile',
    siksAuthAppKey: process.env.SIKS_AUTH_APP_KEY || process.env.DTSEN_APP_KEY || 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=',
    siksHttpLoginUsernameField: process.env.SIKS_HTTP_LOGIN_USERNAME_FIELD || 'email',
    siksDirectCaptchaText: process.env.SIKS_HTTP_LOGIN_CAPTCHA || process.env.SIKS_CAPTCHA_TEXT || '',
    siksDirectOtp: process.env.SIKS_HTTP_LOGIN_OTP || process.env.SIKS_OTP || '',
    siksUsername: process.env.SIKS_USERNAME || '',
    siksPassword: process.env.SIKS_PASSWORD || '',
    siksBaseUrl,
    siksOrigin: ensureTrailingSlash(process.env.SIKS_ORIGIN || siksBaseUrl),
    siksLoginUrl: process.env.SIKS_LOGIN_URL || joinUrl(siksBaseUrl, '/login'),
    siksDtsenViewPath: process.env.SIKS_DTSEN_VIEW_PATH || '/data-bnba-dtsen',
    siksMenuArrowText: process.env.SIKS_MENU_ARROW_TEXT || 'arrow_right',
    siksDtsenMenuText: process.env.SIKS_DTSEN_MENU_TEXT || 'View DTSEN',
    siksSearchButtonText: process.env.SIKS_SEARCH_BUTTON_TEXT || 'Cari',
    siksNotFoundText: process.env.SIKS_NOT_FOUND_TEXT || 'Data Tidak Ditemukan',
    siksDetailTitleText: process.env.SIKS_DETAIL_TITLE_TEXT || 'Detail Data DTSEN',
    siksRiwayatText: process.env.SIKS_RIWAYAT_TEXT || 'Riwayat Bansos',
    siksNoRiwayatText: process.env.SIKS_NO_RIWAYAT_TEXT || 'Tidak Ada Riwayat Penerimaan Bansos',
    siksRiwayatPkhText: process.env.SIKS_RIWAYAT_PKH_TEXT || 'PKH',
    siksRiwayatSembakoText: process.env.SIKS_RIWAYAT_SEMBAKO_TEXT || 'SEMBAKO',
    siksRiwayatPbiText: process.env.SIKS_RIWAYAT_PBI_TEXT || 'PBI',
    siksPkhPeriodText: process.env.SIKS_PKH_PERIOD_TEXT || 'PKH OKT - DES 2025',
    siksSembakoPeriodText: process.env.SIKS_SEMBAKO_PERIOD_TEXT || 'SEMBAKO OKT - DES 2025',
    siksPbiProgramText: process.env.SIKS_PBI_PROGRAM_TEXT || 'PBI JKN',
    siksPbiStartYear: process.env.SIKS_PBI_START_YEAR || '2025',
    siksPbiEndYear: process.env.SIKS_PBI_END_YEAR || '2026',
    siksPbiEndMonths: listEnv('SIKS_PBI_END_MONTHS').length ? listEnv('SIKS_PBI_END_MONTHS') : ['JANUARI', 'FEBRUARI'],
    siksPbiFlagValue: process.env.SIKS_PBI_FLAG_VALUE || 'PBI januari',
    siksOtpValidationSelectors: listEnv('SIKS_OTP_VALIDATION_SELECTORS').length ? listEnv('SIKS_OTP_VALIDATION_SELECTORS') : ['button#\\:rf\\:', 'button[type="button"]#\\:rf\\:'],
    siksOtpSubmitAttempts: numberEnv('SIKS_OTP_SUBMIT_ATTEMPTS', 20),
    siksOtpRetryDelayMs: numberEnv('SIKS_OTP_RETRY_DELAY_MS', 1500),
    siksSelectors: {
      loginUsername: process.env.SIKS_LOGIN_USERNAME_SELECTOR || 'input[name="username"]',
      loginPassword: process.env.SIKS_LOGIN_PASSWORD_SELECTOR || 'input[name="password"]',
      loginCaptcha: process.env.SIKS_LOGIN_CAPTCHA_SELECTOR || 'input[name="captcha"]',
      captchaImage: process.env.SIKS_CAPTCHA_IMAGE_SELECTOR || 'img[alt="captcha"]',
      otpBox: process.env.SIKS_OTP_BOX_SELECTOR || 'div.MuiOtpInput-Box',
      otpInputs: process.env.SIKS_OTP_INPUTS_SELECTOR || 'div.MuiOtpInput-Box input',
      alertDialog: process.env.SIKS_ALERT_DIALOG_SELECTOR || 'p#alert-dialog-description',
      treeItemLabel: process.env.SIKS_TREE_ITEM_LABEL_SELECTOR || 'div.MuiTreeItem-label',
      nikInput: process.env.SIKS_NIK_INPUT_SELECTOR || 'input[maxlength="17"][type="text"]',
      kkInput: process.env.SIKS_KK_INPUT_SELECTOR || 'input#outlined-password-input',
      detailButton: process.env.SIKS_DETAIL_BUTTON_SELECTOR || 'button[aria-label="detail"]',
      detailPanel: process.env.SIKS_DETAIL_PANEL_SELECTOR || 'div.css-1en3swl',
      detailCloseButton: process.env.SIKS_DETAIL_CLOSE_BUTTON_SELECTOR || 'button[aria-label="close"]',
    },
    dtsenPageUrl: process.env.DTSEN_PAGE_URL || joinUrl(siksBaseUrl, '/data-bnba-dtsen'),
    dtsenAuthorizationHosts: listEnv('DTSEN_AUTHORIZATION_HOSTS').length ? listEnv('DTSEN_AUTHORIZATION_HOSTS') : [process.env.DTSEN_AUTHORIZATION_HOST || 'api.kemensos.go.id'],
    dtsenApiUrl: process.env.DTSEN_API_URL || process.env.DTSEN_SEARCH_API_URL || 'https://api.kemensos.go.id/dtsen/view-dtsen/v1/get-keluarga-dtsen',
    dtsenDetailKeluargaApiUrl: process.env.DTSEN_DETAIL_KELUARGA_API_URL || 'https://api.kemensos.go.id/dtsen/individu/v1/get-detail-keluarga',
    dtsenDesilApiUrl: process.env.DTSEN_DESIL_API_URL || 'https://api.kemensos.go.id/dtsen/individu/v1/get-desil-dtsen-by-id',
    dtsenAnggotaApiUrl: process.env.DTSEN_ANGGOTA_API_URL || 'https://api.kemensos.go.id/dtsen/view-dtsen/v1/get-anggota-keluarga-dtsen-by-id-keluarga',
    dtsenAppKey: process.env.DTSEN_APP_KEY || 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=',
    dtsenCrypto: {
      algorithm: process.env.DTSEN_CRYPTO_ALGORITHM || 'aes-256-gcm',
      ivBytes: numberEnv('DTSEN_CRYPTO_IV_BYTES', 12),
      tagBytes: numberEnv('DTSEN_CRYPTO_TAG_BYTES', 16),
      encoding: process.env.DTSEN_CRYPTO_ENCODING || 'base64',
    },
    dtsenAuthTimeoutMs: numberEnv('DTSEN_AUTH_TIMEOUT_MS', 30000),
    dtsenApiTimeoutMs: numberEnv('DTSEN_API_TIMEOUT_MS', 60000),
    dtsenApiRetryAttempts: numberEnv('DTSEN_API_RETRY_ATTEMPTS', 2),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiApiKeys: uniqueList([process.env.GEMINI_API_KEY || '', ...listEnv('GEMINI_API_KEYS')]),
    geminiApiModel: geminiModel,
    geminiGenerateUrlTemplate: process.env.GEMINI_GENERATE_URL_TEMPLATE || 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}',
    geminiRequestTimeoutMs: numberEnv('GEMINI_REQUEST_TIMEOUT_MS', 30000),
    geminiKeyCooldownMs: numberEnv('GEMINI_KEY_COOLDOWN_MS', 60000),
    captchaPattern: process.env.CAPTCHA_PATTERN || '([A-Z]{3}[0-9])',
    captchaLength: numberEnv('CAPTCHA_LENGTH', 4),
    telegramOtpUrl: process.env.TELEGRAM_OTP_URL || '',
    telegramMessageSelector: process.env.TELEGRAM_MESSAGE_SELECTOR || 'div.message-content-wrapper.can-select-text div.content-inner > div',
    telegramGoToBottomSelector: process.env.TELEGRAM_GO_TO_BOTTOM_SELECTOR || 'button[aria-label="Go to bottom"], button[title="Go to bottom"]',
    telegramGoToBottomTexts: listEnv('TELEGRAM_GO_TO_BOTTOM_TEXTS').length ? listEnv('TELEGRAM_GO_TO_BOTTOM_TEXTS') : ['go to bottom', 'scroll to bottom', 'jump to bottom', 'pesan terbaru', 'ke bawah'],
    telegramOtpPrefix: process.env.TELEGRAM_OTP_PREFIX || 'Kode OTP:',
    telegramOtpWaitTimeoutMs: numberEnv('TELEGRAM_OTP_WAIT_TIMEOUT_MS', 60000),
    telegramOtpReadAttempts: numberEnv('TELEGRAM_OTP_READ_ATTEMPTS', 5),
    telegramNewOtpWaitAttempts: numberEnv('TELEGRAM_NEW_OTP_WAIT_ATTEMPTS', 30),
    telegramScrollAttempts: numberEnv('TELEGRAM_SCROLL_ATTEMPTS', 6),
    telegramSettleScrollAttempts: numberEnv('TELEGRAM_SETTLE_SCROLL_ATTEMPTS', 3),
    archiveFile: process.env.ARCHIVE_FILE || './output/hasil.txt',
  };
}

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

function ensureTrailingSlash(value) {
  return `${trimSlash(String(value || ''))}/`;
}

function joinUrl(base, pathPart) {
  return `${trimSlash(String(base || ''))}/${String(pathPart || '').replace(/^\/+/, '')}`;
}

function numberEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(key, fallback) {
  const value = process.env[key];
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function argValue(args, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i] || '');
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length).trim();
    }
    if (value === name && args[i + 1]) {
      return String(args[i + 1]).trim();
    }
  }
  return '';
}

function listEnv(key) {
  return String(process.env[key] || '')
    .split(/[\n,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
