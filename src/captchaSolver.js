import fs from 'fs-extra';
import { fetchWithTimeout } from './httpClient.js';

let geminiKeyCursor = 0;
const geminiKeyCooldownUntil = new Map();

export async function getCaptchaTextFromGemini(imageInput, config = {}) {
  const apiKeys = Array.isArray(config.geminiApiKeys) && config.geminiApiKeys.length
    ? config.geminiApiKeys
    : (config.geminiApiKey ? [config.geminiApiKey] : []);
  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEY atau GEMINI_API_KEYS wajib diisi untuk membaca captcha otomatis.');
  }

  const buffer = Buffer.isBuffer(imageInput) ? imageInput : await fs.readFile(imageInput);
  const payload = {
    contents: [{
      parts: [
        { text: 'Bacalah CAPTCHA pada gambar ini dan balas hanya isi kodenya tanpa penjelasan tambahan:' },
        { inline_data: { mime_type: guessMimeType(imageInput, buffer), data: buffer.toString('base64') } },
      ],
    }],
  };

  let lastError = null;
  const orderedKeys = orderedGeminiKeys(apiKeys);
  for (const { key, index } of orderedKeys) {
    try {
      const text = await requestGeminiCaptcha(payload, key, config);
      geminiKeyCooldownUntil.delete(key);
      geminiKeyCursor = (index + 1) % apiKeys.length;
      return text;
    } catch (error) {
      lastError = error;
      if (isRetryableGeminiError(error)) {
        coolDownGeminiKey(key, config);
      }
      if (!isRetryableGeminiError(error) && apiKeys.length === 1) {
        throw error;
      }
    }
  }
  throw lastError || new Error('Semua Gemini API key gagal membaca captcha.');
}

async function requestGeminiCaptcha(payload, apiKey, config) {
  const model = encodeURIComponent(config.geminiApiModel || 'gemini-2.5-flash');
  const url = String(config.geminiGenerateUrlTemplate || 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}')
    .replace('{model}', model)
    .replace('{key}', encodeURIComponent(apiKey));
  const timeoutMs = Math.max(1000, Number(config.geminiRequestTimeoutMs || 30000));
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, {
    timeoutMs,
    timeoutMessage: `Gemini timeout setelah ${Math.round(timeoutMs / 1000)} detik.`,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result?.error?.message || `Gemini HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pattern = new RegExp(config.captchaPattern || '([A-Z]{3}[0-9])');
  const match = cleaned.match(pattern);
  const captchaLength = Math.max(1, Number(config.captchaLength || 4));
  const captcha = match ? (match[1] || match[0]) : cleaned.slice(0, captchaLength);
  if (!captcha) {
    throw new Error('Gemini tidak mengembalikan teks captcha.');
  }
  return captcha;
}

function isRetryableGeminiError(error) {
  const status = Number(error?.status || 0);
  return status === 0 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function orderedGeminiKeys(apiKeys) {
  const now = Date.now();
  const start = geminiKeyCursor % apiKeys.length;
  const items = apiKeys.map((_, offset) => {
    const index = (start + offset) % apiKeys.length;
    const key = apiKeys[index];
    const cooldownUntil = Number(geminiKeyCooldownUntil.get(key) || 0);
    return { key, index, coolingDown: cooldownUntil > now, cooldownUntil };
  });
  const available = items.filter(item => !item.coolingDown);
  if (available.length) {
    return available;
  }
  return items.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
}

function coolDownGeminiKey(apiKey, config) {
  const cooldownMs = Math.max(0, Number(config.geminiKeyCooldownMs || 0));
  if (cooldownMs > 0) {
    geminiKeyCooldownUntil.set(apiKey, Date.now() + cooldownMs);
  }
}

function guessMimeType(imageInput, buffer) {
  const name = String(Buffer.isBuffer(imageInput) ? '' : imageInput || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return 'image/png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return 'image/jpeg';
  if (buffer?.subarray?.(0, 4)?.toString('ascii') === 'RIFF') return 'image/webp';
  return 'image/png';
}
