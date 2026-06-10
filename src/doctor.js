import fs from 'fs-extra';
import { readConfig } from './env.js';
import { requestJson } from './httpClient.js';
import { workerApiUrl, workerAuthHeaders } from './workerApiEndpoints.js';

const config = readConfig();
const checks = [];

function addCheck(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), detail });
}

async function main() {
  addCheck('WORKER_API_KEY', Boolean(config.workerApiKey), config.workerApiKey ? 'configured' : 'missing');
  addCheck('SIKS credentials', Boolean(config.siksUsername && config.siksPassword), config.siksUsername && config.siksPassword ? 'configured' : 'missing username/password');
  const directAuth = isDirectAuthMode(config.siksAuthMode);
  addCheck('SIKS auth mode', true, config.siksAuthMode || 'puppeteer');
  addCheck('Gemini keys', config.geminiApiKeys.length > 0 || (directAuth && config.siksDirectCaptchaText), config.geminiApiKeys.length ? `${config.geminiApiKeys.length} key(s)` : 'manual captcha override');
  addCheck('Chrome executable', directAuth || Boolean(config.chromeExecutablePath && await fs.pathExists(config.chromeExecutablePath)), directAuth ? 'not required for direct auth' : (config.chromeExecutablePath || 'missing'));
  addCheck('Browser keep-open mode', true, directAuth ? 'not used by direct auth' : (config.keepBrowserOpen ? 'enabled' : 'disabled'));
  addCheck('API fallback directory', true, config.apiFallbackDir);
  addTimingChecks();

  await checkApiHealth();
  await checkWorkerAuth();

  for (const check of checks) {
    const marker = check.ok ? '[OK]' : '[FAIL]';
    console.log(`${marker} ${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  if (checks.some(check => !check.ok)) {
    process.exitCode = 1;
  }
}

function addTimingChecks() {
  addCheck('API request timeout', Number(config.apiRequestTimeoutMs) >= 1000, `${config.apiRequestTimeoutMs} ms`);
  addCheck('SIKS auth timeout', Number(config.siksAuthTimeoutMs) >= 1000, `${config.siksAuthTimeoutMs} ms`);
  addCheck('SIKS action timeout', Number(config.siksActionTimeoutMs) >= 1000, `${config.siksActionTimeoutMs} ms`);
  addCheck('SIKS search timeout', Number(config.siksSearchTimeoutMs) >= Number(config.siksActionTimeoutMs), `${config.siksSearchTimeoutMs} ms`);
  addCheck('Telegram OTP wait timeout', Number(config.telegramOtpWaitTimeoutMs) >= Number(config.siksActionTimeoutMs), `${config.telegramOtpWaitTimeoutMs} ms`);
  addCheck('Telegram new OTP attempts', Number(config.telegramNewOtpWaitAttempts) >= Number(config.telegramOtpReadAttempts), `${config.telegramNewOtpWaitAttempts} attempts`);
  addCheck('SIKS OTP submit attempts', Number(config.siksOtpSubmitAttempts) >= 1, `${config.siksOtpSubmitAttempts} attempts`);
  addCheck('SIKS session probe', Number(config.siksSessionProbeIntervalMs) >= 0, `${config.siksSessionProbeIntervalMs} ms`);
  addCheck('SIKS session recovery', Number(config.siksSessionRecoveryAttempts) >= 1, `${config.siksSessionRecoveryAttempts} attempts`);
  addCheck('Row timeout budget', Number(config.rowTimeoutMs) >= Number(config.siksActionTimeoutMs), `${config.rowTimeoutMs} ms`);
  addCheck('Row error recheck', !config.recheckErrorRowsBeforeComplete || Number(config.rowErrorRecheckAttempts) >= 1, config.recheckErrorRowsBeforeComplete ? `${config.rowErrorRecheckAttempts} attempts` : 'disabled');
}

async function checkApiHealth() {
  try {
    const data = await workerRequestJson(workerApiUrl(config, 'health'));
    addCheck('API health', Boolean(data?.ok), data?.time || 'reachable');
  } catch (error) {
    addCheck('API health', false, error.message);
  }
}

async function checkWorkerAuth() {
  if (!config.workerApiKey) {
    addCheck('Worker API auth', false, 'missing key');
    return;
  }
  try {
    const data = await workerRequestJson(workerApiUrl(config, 'ping'), {
      method: 'POST',
      headers: workerAuthHeaders(config, {
        'Content-Type': 'application/json',
      }),
      body: '{}',
    });
    addCheck('Worker API auth', Boolean(data?.ok), data?.time || 'accepted');
  } catch (error) {
    addCheck('Worker API auth', false, error.message);
  }
}

async function workerRequestJson(url, options = {}) {
  return requestJson(url, options, {
    ...config,
    apiRetryAttempts: 1,
    apiRequestTimeoutMs: Math.min(Number(config.apiRequestTimeoutMs || 10000), 10000),
  });
}

main().catch(error => {
  console.error(`[FAIL] doctor crashed - ${error.message}`);
  process.exitCode = 1;
});

function isDirectAuthMode(value) {
  return ['direct', 'http', 'api', 'login-direct'].includes(String(value || '').trim().toLowerCase());
}
