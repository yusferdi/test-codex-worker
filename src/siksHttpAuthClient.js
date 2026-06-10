import { fetchWithTimeout } from './httpClient.js';

export class HttpCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  addFromHeaders(headers, baseUrl = '') {
    const values = setCookieValues(headers);
    for (const value of values) {
      const parsed = parseSetCookie(value, baseUrl);
      if (!parsed?.name) continue;
      this.cookies.set(parsed.name, parsed);
    }
  }

  header() {
    return Array.from(this.cookies.values())
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  summary() {
    return Array.from(this.cookies.values()).map(cookie => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      value: cookie.value ? '[redacted]' : '',
    }));
  }
}

export class SiksHttpAuthClient {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || config.siksActionTimeoutMs || 15000));
    this.jar = options.cookieJar || new HttpCookieJar();
    this.userAgent = options.userAgent || 'Mozilla/5.0 KAT-Worker-HttpAuthProbe/1.0';
  }

  async getLoginPage() {
    const response = await this.request(this.config.siksLoginUrl, {
      method: 'GET',
      headers: this.baseHeaders(),
    });
    const html = await response.text();
    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      html,
      forms: extractForms(html, response.url),
      captcha: extractCaptchaCandidates(html, response.url),
      cookies: this.jar.summary(),
    };
  }

  async submitLogin({ username, password, captcha = '', formIndex = 0, extraFields = {} } = {}) {
    const page = await this.getLoginPage();
    const form = page.forms[formIndex] || defaultLoginForm(this.config.siksLoginUrl);
    const fields = {
      ...form.hidden,
      [fieldNameFromSelector(this.config.siksSelectors?.loginUsername, 'username')]: username || '',
      [fieldNameFromSelector(this.config.siksSelectors?.loginPassword, 'password')]: password || '',
      [fieldNameFromSelector(this.config.siksSelectors?.loginCaptcha, 'captcha')]: captcha || '',
      ...extraFields,
    };
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (key) body.set(key, String(value ?? ''));
    }

    const response = await this.request(form.action, {
      method: form.method || 'POST',
      headers: {
        ...this.baseHeaders(form.action),
        'content-type': 'application/x-www-form-urlencoded',
        referer: page.url,
      },
      body,
      redirect: 'manual',
    });
    const text = await response.text().catch(() => '');
    return {
      status: response.status,
      ok: response.ok || response.status === 302 || response.status === 303,
      location: response.headers.get('location') || '',
      cookies: this.jar.summary(),
      bodyPreview: sanitizeText(text).slice(0, 1200),
    };
  }

  async request(url, options = {}) {
    const headers = {
      ...options.headers,
      cookie: this.jar.header(),
    };
    if (!headers.cookie) delete headers.cookie;
    const response = await fetchWithTimeout(url, {
      ...options,
      headers,
    }, {
      timeoutMs: this.timeoutMs,
      timeoutMessage: `HTTP auth request timeout setelah ${Math.round(this.timeoutMs / 1000)} detik.`,
    });
    this.jar.addFromHeaders(response.headers, url);
    return response;
  }

  baseHeaders(url = this.config.siksLoginUrl) {
    return {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent': this.userAgent,
      origin: originFrom(url || this.config.siksOrigin || this.config.siksBaseUrl || ''),
    };
  }
}

export function extractForms(html, baseUrl = '') {
  const forms = [];
  const formRegex = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const match of html.matchAll(formRegex)) {
    const formHtml = match[0];
    const action = attr(formHtml, 'action') || baseUrl;
    const method = (attr(formHtml, 'method') || 'POST').toUpperCase();
    const hidden = {};
    for (const input of formHtml.matchAll(/<input\b[^>]*>/gi)) {
      const inputHtml = input[0];
      const name = attr(inputHtml, 'name');
      if (!name) continue;
      const type = (attr(inputHtml, 'type') || '').toLowerCase();
      if (type === 'hidden') {
        hidden[name] = attr(inputHtml, 'value') || '';
      }
    }
    forms.push({
      action: absoluteUrl(action, baseUrl),
      method,
      hidden,
      inputNames: Array.from(formHtml.matchAll(/<input\b[^>]*>/gi)).map(input => attr(input[0], 'name')).filter(Boolean),
    });
  }
  return forms;
}

export function extractCaptchaCandidates(html, baseUrl = '') {
  const candidates = [];
  for (const img of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = img[0];
    const src = attr(tag, 'src');
    const alt = attr(tag, 'alt');
    const id = attr(tag, 'id');
    const klass = attr(tag, 'class');
    const haystack = `${src} ${alt} ${id} ${klass}`.toLowerCase();
    if (!src || !haystack.includes('captcha')) continue;
    candidates.push({
      src: src.startsWith('data:') ? '[data-uri-redacted]' : absoluteUrl(src, baseUrl),
      alt,
      id,
      className: klass,
      isDataUri: src.startsWith('data:'),
    });
  }
  return candidates;
}

function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const one = headers.get?.('set-cookie');
  return one ? splitCombinedSetCookie(one) : [];
}

function splitCombinedSetCookie(header) {
  return String(header || '').split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map(value => value.trim()).filter(Boolean);
}

function parseSetCookie(value, baseUrl = '') {
  const parts = String(value || '').split(';').map(part => part.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    domain: safeHostname(baseUrl),
    path: '/',
    secure: false,
    httpOnly: false,
  };
  for (const attrText of attrs) {
    const [keyRaw, valueRaw = ''] = attrText.split('=');
    const key = keyRaw.toLowerCase();
    if (key === 'domain') cookie.domain = valueRaw;
    if (key === 'path') cookie.path = valueRaw || '/';
    if (key === 'secure') cookie.secure = true;
    if (key === 'httponly') cookie.httpOnly = true;
  }
  return cookie;
}

function attr(html, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(html || '').match(pattern);
  return match ? decodeHtml(match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return String(value || '');
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function originFrom(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function fieldNameFromSelector(selector, fallback) {
  const match = String(selector || '').match(/\[name=["']?([^"'\]]+)/i);
  return match?.[1] || fallback;
}

function defaultLoginForm(loginUrl) {
  return { action: loginUrl, method: 'POST', hidden: {}, inputNames: [] };
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{12,20}\b/g, '[digits]');
}
