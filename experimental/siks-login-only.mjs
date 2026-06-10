import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/env.js';
import { SiksSpaAuthClient, extractToken } from '../src/siksSpaAuthClient.js';

const execAsync = promisify(exec);
const config = readConfig();
const args = parseArgs(process.argv.slice(2));
const submit = args.submit || process.env.SIKS_HTTP_LOGIN_ALLOW_SUBMIT === '1';
const outDir = path.resolve('output/auth-probe');
await fs.mkdir(outDir, { recursive: true });

const client = new SiksSpaAuthClient(config, {
  timeoutMs: Number(process.env.SIKS_LOGIN_ONLY_TIMEOUT_MS || config.siksActionTimeoutMs || 15000),
});

const summary = {
  ok: true,
  mode: submit ? 'login-only' : 'captcha-only',
  endpoints: client.endpoints,
  usernameField: client.usernameField,
  captcha: null,
  login: null,
  otp: null,
  profile: null,
  session: null,
  notes: [],
  time: new Date().toISOString(),
};

try {
  const captcha = await client.getCaptcha();
  summary.captcha = summarizeResponse(captcha);
} catch (error) {
  summary.ok = false;
  summary.captcha = { error: error.message };
}

if (submit) {
  const captchaText = args.captcha || process.env.SIKS_HTTP_LOGIN_CAPTCHA || '';
  if (!captchaText) {
    summary.login = {
      skipped: true,
      reason: 'Captcha belum diisi. Jalankan dengan --captcha=ABCD atau env SIKS_HTTP_LOGIN_CAPTCHA.',
    };
  } else {
    try {
      const login = await client.login({
        username: config.siksUsername,
        password: config.siksPassword,
        captcha: captchaText,
        extra: jsonEnv('SIKS_LOGIN_EXTRA_JSON'),
      });
      summary.login = summarizeLogin(login.data, login.authorization);
      if (requiresOtp(login.data)) {
        const otp = await resolveOtp(args, config);
        if (!otp) {
          summary.otp = {
            skipped: true,
            reason: 'Login meminta OTP, tetapi OTP belum tersedia dari env/file/command/API.',
          };
        } else {
          const otpResult = await client.matchingOtp({
            otp,
            email: config.siksUsername,
            extra: {
              ...jsonEnv('SIKS_OTP_EXTRA_JSON'),
              type: process.env.SIKS_OTP_PAYLOAD_TYPE || 'sendotp',
            },
          });
          summary.otp = summarizeLogin(otpResult.data, otpResult.authorization);
        }
      }

      if (client.token) {
        const profile = await client.getProfile().catch(error => ({ error: error.message }));
        summary.profile = summarizeResponse(profile);
        summary.session = makeSession(client.token);
      }
    } catch (error) {
      summary.ok = false;
      summary.login = { ok: false, error: error.message };
    }
  }
} else {
  summary.notes.push('Mode default hanya mengambil captcha endpoint dan tidak mengirim kredensial.');
}

const outPath = path.join(outDir, `siks-login-only-${Date.now()}.json`);
await fs.writeFile(outPath, JSON.stringify(redactForStorage(summary), null, 2));

console.log(JSON.stringify({
  ok: summary.ok,
  output: outPath,
  mode: summary.mode,
  captcha: summary.captcha,
  login: summary.login ? {
    skipped: Boolean(summary.login.skipped),
    requiresOtp: Boolean(summary.login.requiresOtp),
    authorizationCaptured: Boolean(summary.login.authorizationCaptured),
    code: summary.login.code || '',
    error: summary.login.error || '',
  } : null,
  otp: summary.otp ? {
    skipped: Boolean(summary.otp.skipped),
    authorizationCaptured: Boolean(summary.otp.authorizationCaptured),
    code: summary.otp.code || '',
    error: summary.otp.error || '',
  } : null,
  sessionReady: Boolean(summary.session?.authorization),
}, null, 2));

function parseArgs(items) {
  const out = {};
  for (const item of items) {
    if (item === '--submit') out.submit = true;
    if (item.startsWith('--captcha=')) out.captcha = item.slice('--captcha='.length).trim();
    if (item.startsWith('--otp=')) out.otp = item.slice('--otp='.length).trim();
  }
  return out;
}

function summarizeLogin(data, authorization) {
  const authData = data?.data?.data?.data || data?.data?.data || data?.data || data || {};
  return {
    ok: Boolean(authorization || extractToken(data)),
    code: String(authData?.code || data?.code || ''),
    status: data?.status ?? data?.success ?? null,
    message: String(data?.message || data?.data?.message || ''),
    authType: String(authData?.jenis_autentikasi || ''),
    requiresOtp: requiresOtp(data),
    authorizationCaptured: Boolean(authorization || extractToken(data)),
    shape: shapeOf(data),
  };
}

function summarizeResponse(data) {
  if (data?.error) {
    return { error: data.error };
  }
  return {
    code: String(data?.code || ''),
    status: data?.status ?? data?.success ?? null,
    message: String(data?.message || ''),
    shape: shapeOf(data),
  };
}

function requiresOtp(data) {
  const authData = data?.data?.data?.data || data?.data?.data || data?.data || data || {};
  return String(authData?.code || '').toLowerCase() === 'otp_req';
}

function makeSession(token) {
  const authorization = String(token || '').trim();
  return {
    authorization: process.env.SIKS_LOGIN_ONLY_SAVE_TOKEN === '1' ? authorization : '[redacted]',
    authorizationCaptured: Boolean(authorization),
    cookies: '',
    expiresAt: '',
    source: 'http-spa-login-only',
  };
}

async function resolveOtp(argsMap, cfg) {
  const direct = argsMap.otp || process.env.SIKS_OTP || process.env.SIKS_HTTP_LOGIN_OTP || '';
  if (direct) return matchOtp(direct, cfg.telegramOtpPrefix);

  const file = process.env.TELEGRAM_OTP_FILE || '';
  if (file) {
    const text = await fs.readFile(path.resolve(file), 'utf8').catch(() => '');
    const otp = matchOtp(text, cfg.telegramOtpPrefix);
    if (otp) return otp;
  }

  const command = process.env.TELEGRAM_TDLIB_OTP_COMMAND || '';
  if (command) {
    const { stdout } = await execAsync(command, { timeout: Number(process.env.TELEGRAM_TDLIB_OTP_TIMEOUT_MS || 30000) });
    const otp = matchOtp(stdout, cfg.telegramOtpPrefix);
    if (otp) return otp;
  }

  const url = process.env.TELEGRAM_OTP_API_URL || '';
  if (url) {
    const response = await fetch(url, {
      headers: process.env.TELEGRAM_OTP_API_TOKEN ? { authorization: `Bearer ${process.env.TELEGRAM_OTP_API_TOKEN}` } : {},
    }).catch(() => null);
    const text = response ? await response.text().catch(() => '') : '';
    const otp = matchOtp(text, cfg.telegramOtpPrefix);
    if (otp) return otp;
  }

  return '';
}

function matchOtp(text, prefix = 'Kode OTP:') {
  const value = String(text || '');
  const normalizedPrefix = String(prefix || '').trim();
  if (normalizedPrefix) {
    const idx = value.toLowerCase().lastIndexOf(normalizedPrefix.toLowerCase());
    if (idx !== -1) {
      const sliced = value.slice(idx + normalizedPrefix.length);
      const prefixed = sliced.match(/\b(\d{4,8})\b/);
      if (prefixed) return prefixed[1];
    }
  }
  const generic = value.match(/\b(\d{4,8})\b/g);
  return generic ? generic[generic.length - 1] : '';
}

function jsonEnv(name) {
  const raw = process.env[name] || '';
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function shapeOf(value) {
  if (Array.isArray(value)) return value.map(item => typeof item);
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => [
    key,
    typeof item === 'string' ? `string:${item.length}` : Array.isArray(item) ? `array:${item.length}` : typeof item,
  ]));
}

function redactForStorage(value) {
  if (Array.isArray(value)) return value.map(redactForStorage);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/password|authorization|token|secret|captcha|otp/i.test(key) && typeof item === 'string' && item.length > 0) {
      return [key, '[redacted]'];
    }
    return [key, redactForStorage(item)];
  }));
}
