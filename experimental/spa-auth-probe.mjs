import fs from 'fs-extra';
import path from 'path';
import { readConfig } from '../src/env.js';
import { SiksSpaAuthClient } from '../src/siksSpaAuthClient.js';

const config = readConfig();
const args = new Set(process.argv.slice(2));
const submit = args.has('--submit') || process.env.SIKS_HTTP_LOGIN_ALLOW_SUBMIT === '1';
const outDir = path.resolve('output', 'auth-probe');
await fs.ensureDir(outDir);

const client = new SiksSpaAuthClient(config);
const summary = {
  mode: submit ? 'submit' : 'captcha-only',
  endpoints: {
    baseUrl: config.siksAuthApiBaseUrl,
    login: config.siksAuthLoginEndpoint,
    captcha: config.siksAuthCaptchaEndpoint,
    matchingOtp: config.siksAuthMatchingOtpEndpoint,
    profile: config.siksAuthProfileEndpoint,
  },
};

summary.captcha = await client.getCaptcha().catch(error => ({
  error: error.message,
}));

if (submit) {
  const captcha = process.env.SIKS_HTTP_LOGIN_CAPTCHA || '';
  if (!captcha) {
    summary.login = {
      skipped: true,
      reason: 'SIKS_HTTP_LOGIN_CAPTCHA kosong. Isi manual captcha dulu sebelum submit.',
    };
  } else {
    summary.login = await client.login({
      username: config.siksUsername,
      password: config.siksPassword,
      captcha,
    }).then(result => ({
      ok: Boolean(result.authorization),
      authorizationCaptured: Boolean(result.authorization),
      dataShape: describeShape(result.data),
    })).catch(error => ({
      ok: false,
      error: error.message,
    }));
  }
}

const outputPath = path.join(outDir, `spa-auth-probe-${Date.now()}.json`);
await fs.writeJson(outputPath, redact(summary), { spaces: 2 });
console.log(JSON.stringify({
  ok: true,
  output: outputPath,
  mode: summary.mode,
  captchaShape: describeShape(summary.captcha),
  login: summary.login ? {
    skipped: Boolean(summary.login.skipped),
    ok: Boolean(summary.login.ok),
    authorizationCaptured: Boolean(summary.login.authorizationCaptured),
    error: summary.login.error || '',
  } : null,
}, null, 2));

function describeShape(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return Object.keys(value).slice(0, 12);
  return typeof value;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|authorization|password|secret|captcha/i.test(key) && typeof item === 'string') {
      out[key] = item ? '[redacted]' : '';
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}
