import fs from 'fs-extra';
import path from 'path';
import { readConfig } from '../src/env.js';
import { SiksHttpAuthClient } from '../src/siksHttpAuthClient.js';

const config = readConfig();
const args = new Set(process.argv.slice(2));
const submit = args.has('--submit') || process.env.SIKS_HTTP_LOGIN_ALLOW_SUBMIT === '1';
const outDir = path.resolve('output', 'auth-probe');

await fs.ensureDir(outDir);

const client = new SiksHttpAuthClient(config);
const loginPage = await client.getLoginPage();
const summary = {
  mode: submit ? 'submit' : 'inspect-only',
  loginUrl: config.siksLoginUrl,
  finalUrl: loginPage.url,
  status: loginPage.status,
  ok: loginPage.ok,
  forms: loginPage.forms.map(form => ({
    action: form.action,
    method: form.method,
    hiddenFields: Object.keys(form.hidden),
    inputNames: form.inputNames,
  })),
  captchaCandidates: loginPage.captcha,
  cookies: loginPage.cookies,
};

if (submit) {
  if (!process.env.SIKS_HTTP_LOGIN_CAPTCHA) {
    summary.submit = {
      skipped: true,
      reason: 'SIKS_HTTP_LOGIN_CAPTCHA kosong. Isi manual hasil captcha dulu, atau gunakan flow OCR terpisah.',
    };
  } else {
    summary.submit = await client.submitLogin({
      username: config.siksUsername,
      password: config.siksPassword,
      captcha: process.env.SIKS_HTTP_LOGIN_CAPTCHA,
    });
  }
}

const outputPath = path.join(outDir, `http-login-probe-${Date.now()}.json`);
await fs.writeJson(outputPath, summary, { spaces: 2 });
console.log(JSON.stringify({
  ok: true,
  output: outputPath,
  mode: summary.mode,
  status: summary.status,
  forms: summary.forms.length,
  captchaCandidates: summary.captchaCandidates.length,
  submit: summary.submit ? {
    skipped: Boolean(summary.submit.skipped),
    status: summary.submit.status || null,
    ok: Boolean(summary.submit.ok),
    location: summary.submit.location || '',
  } : null,
}, null, 2));
