import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const DEFAULT_CRYPTO = {
  algorithm: 'aes-256-gcm',
  ivBytes: 12,
  tagBytes: 16,
  encoding: 'base64',
};

export function encryptDtsenEntity(text, appKey, options = {}) {
  const crypto = dtsenCryptoOptions(options);
  const key = dtsenKey(appKey);
  const iv = randomBytes(crypto.ivBytes);
  const cipher = createCipheriv(crypto.algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString(crypto.encoding);
}

export function decryptDtsenEntity(value, appKey, options = {}) {
  const crypto = dtsenCryptoOptions(options);
  const key = dtsenKey(appKey);
  const raw = Buffer.from(String(value || ''), crypto.encoding);
  const minLength = crypto.ivBytes + crypto.tagBytes;
  if (raw.length < minLength) {
    throw new Error('Payload DTSEN terlalu pendek untuk didekripsi.');
  }

  const iv = raw.subarray(0, crypto.ivBytes);
  const encrypted = raw.subarray(crypto.ivBytes, raw.length - crypto.tagBytes);
  const tag = raw.subarray(raw.length - crypto.tagBytes);
  const decipher = createDecipheriv(crypto.algorithm, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function decodeDtsenResponse(rawText, appKey, options = {}) {
  const body = parseJsonOrNull(rawText);
  if (!body || typeof body !== 'object') {
    return body || { message: rawText };
  }

  for (const field of ['data', 'code']) {
    if (!isLikelyEncryptedDtsenPayload(body[field], options)) {
      continue;
    }
    const decrypted = decryptDtsenEntity(body[field], appKey, options);
    const parsed = parseJsonOrNull(decrypted) || decrypted;
    if (field === 'data') {
      body.data = parsed;
    } else {
      body.encrypted_code = body.code;
      body.code_payload = parsed;
      if (body.data === undefined || body.data === null || body.data === '') {
        body.data = parsed;
      }
    }
  }

  return body;
}

export function isLikelyEncryptedDtsenPayload(value, options = {}) {
  const crypto = dtsenCryptoOptions(options);
  const text = String(value || '').trim();
  if (!text || text === '0' || !/^[A-Za-z0-9+/=]+$/.test(text) || text.length < 40) {
    return false;
  }
  return Buffer.from(text, crypto.encoding).length >= crypto.ivBytes + crypto.tagBytes;
}

function dtsenCryptoOptions(options = {}) {
  return {
    algorithm: String(options.algorithm || DEFAULT_CRYPTO.algorithm),
    ivBytes: Math.max(1, Number(options.ivBytes || DEFAULT_CRYPTO.ivBytes)),
    tagBytes: Math.max(1, Number(options.tagBytes || DEFAULT_CRYPTO.tagBytes)),
    encoding: String(options.encoding || DEFAULT_CRYPTO.encoding),
  };
}

function dtsenKey(appKey) {
  const key = Buffer.from(String(appKey || '').replace(/^base64:/, ''), 'base64');
  if (key.length !== 32) {
    throw new Error('DTSEN_APP_KEY harus berupa base64 key 32 byte.');
  }
  return key;
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
