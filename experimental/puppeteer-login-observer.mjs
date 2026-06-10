import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { readConfig } from '../src/env.js';

const config = readConfig();
const args = parseArgs(process.argv.slice(2));
const durationMs = Number(args.duration || process.env.SIKS_LOGIN_OBSERVER_DURATION_MS || 15000);
const submit = args.submit || process.env.SIKS_LOGIN_OBSERVER_SUBMIT === '1';
const events = [];
const outDir = path.resolve('output/auth-probe');
await fs.mkdir(outDir, { recursive: true });

const browser = await withTimeout(puppeteer.launch({
  headless: args.headless ?? config.headless,
  executablePath: config.chromeExecutablePath,
  userDataDir: process.env.SIKS_LOGIN_OBSERVER_USER_DATA_DIR || config.siksUserDataDir,
  defaultViewport: { width: 1366, height: 900 },
  timeout: config.browserLaunchTimeoutMs,
  protocolTimeout: config.browserLaunchTimeoutMs,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
}), Math.max(10000, Math.min(config.browserLaunchTimeoutMs, 30000)), 'Timeout meluncurkan browser observer.');

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(Math.min(config.pageDefaultTimeoutMs, 15000));
  page.setDefaultNavigationTimeout(Math.min(config.pageDefaultTimeoutMs, 15000));

  page.on('request', request => {
    const url = request.url();
    if (!isInteresting(url)) return;
    events.push({
      type: 'request',
      ts: new Date().toISOString(),
      method: request.method(),
      url,
      headers: redactHeaders(request.headers()),
      postData: summarizePostData(request.postData() || ''),
    });
  });

  page.on('response', async response => {
    const url = response.url();
    if (!isInteresting(url)) return;
    const text = await response.text().catch(() => '');
    events.push({
      type: 'response',
      ts: new Date().toISOString(),
      status: response.status(),
      url,
      headers: redactHeaders(response.headers()),
      body: summarizeBody(text),
    });
  });

  await withTimeout(
    page.goto(config.siksLoginUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(config.pageDefaultTimeoutMs, 15000) }),
    Math.min(config.pageDefaultTimeoutMs, 15000),
    'Timeout membuka halaman login.'
  ).catch(error => {
    events.push({
      type: 'note',
      ts: new Date().toISOString(),
      message: error.message,
    });
  });

  if (submit) {
    const captcha = args.captcha || process.env.SIKS_HTTP_LOGIN_CAPTCHA || '';
    if (!captcha) {
      events.push({
        type: 'note',
        ts: new Date().toISOString(),
        message: 'Submit diminta, tetapi captcha kosong. Isi --captcha=ABCD atau SIKS_HTTP_LOGIN_CAPTCHA.',
      });
    } else {
      await page.type(config.siksSelectors.loginUsername, config.siksUsername, { delay: 25 }).catch(() => {});
      await page.type(config.siksSelectors.loginPassword, config.siksPassword, { delay: 25 }).catch(() => {});
      await page.type(config.siksSelectors.loginCaptcha, captcha, { delay: 25 }).catch(() => {});
      await clickFirstButton(page);
    }
  }

  await new Promise(resolve => setTimeout(resolve, Math.max(1000, durationMs)));
} finally {
  const outPath = path.join(outDir, `puppeteer-login-observer-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    ok: true,
    loginUrl: config.siksLoginUrl,
    submit,
    durationMs,
    events,
    time: new Date().toISOString(),
  }, null, 2));
  await withTimeout(browser.close(), 8000, 'Timeout menutup browser.').catch(() => {
    try {
      browser.process?.()?.kill?.('SIGKILL');
    } catch {
      // ignore close fallback errors
    }
  });
  console.log(JSON.stringify({
    ok: true,
    output: outPath,
    submit,
    events: events.length,
    methods: [...new Set(events.filter(event => event.type === 'request').map(event => event.method))],
  }, null, 2));
}

function parseArgs(items) {
  const out = {};
  for (const item of items) {
    if (item === '--submit') out.submit = true;
    if (item === '--headless') out.headless = true;
    if (item === '--headed') out.headless = false;
    if (item.startsWith('--duration=')) out.duration = item.slice('--duration='.length);
    if (item.startsWith('--captcha=')) out.captcha = item.slice('--captcha='.length).trim();
  }
  return out;
}

function isInteresting(url) {
  return /siks\/auth|login|captcha|otp|dtsen|api\.kemensos\.go\.id/i.test(url);
}

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [
    key,
    /authorization|cookie|token|secret/i.test(key) && value ? '[redacted]' : value,
  ]));
}

function summarizePostData(text) {
  if (!text) return '';
  return String(text)
    .replace(/(password=)[^&]+/gi, '$1[redacted]')
    .replace(/(captcha=)[^&]+/gi, '$1[redacted]')
    .replace(/(otp=)[^&]+/gi, '$1[redacted]')
    .replace(/(entity=)[^&]+/gi, (_, prefix, value) => `${prefix}[encrypted:${decodeURIComponent(value || '').length}]`)
    .slice(0, 1000);
}

function summarizeBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return raw
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[redacted]"')
    .replace(/"data"\s*:\s*"([^"]{80,})"/gi, (_, value) => `"data":"[string:${value.length}]"`)
    .slice(0, 1200);
}

async function clickFirstButton(page) {
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => !item.disabled);
    if (button) button.click();
  }).catch(() => {});
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise)
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
