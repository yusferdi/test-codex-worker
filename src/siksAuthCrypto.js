import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export function encryptSiksAuthEntity(text, appKey) {
  const key = authKey(appKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64');
  const ivBase64 = iv.toString('base64');
  const mac = createHmac('sha256', key).update(ivBase64 + encrypted).digest('hex');
  return Buffer.from(JSON.stringify({ iv: ivBase64, value: encrypted, mac }), 'utf8').toString('base64');
}

export function decryptSiksAuthEntity(value, appKey) {
  const key = authKey(appKey);
  const envelope = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'));
  if (!envelope?.iv || !envelope?.value || !envelope?.mac) {
    throw new Error('Envelope auth SIKS tidak lengkap.');
  }
  const expectedMac = createHmac('sha256', key).update(String(envelope.iv) + String(envelope.value)).digest('hex');
  if (!timingSafeHexEqual(String(envelope.mac), expectedMac)) {
    throw new Error('MAC auth SIKS tidak valid.');
  }
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(String(envelope.iv), 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(String(envelope.value), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function decodeSiksAuthResponse(rawText, appKey) {
  const text = String(rawText || '').trim();
  if (!text) {
    return null;
  }

  const parsed = parseJson(text);
  if (typeof parsed === 'string' && isLikelyAuthEnvelope(parsed)) {
    return parseJson(decryptSiksAuthEntity(parsed, appKey));
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.data === 'string' && isLikelyAuthEnvelope(parsed.data)) {
      return { ...parsed, data: parseJson(decryptSiksAuthEntity(parsed.data, appKey)) };
    }
    return parsed;
  }
  if (isLikelyAuthEnvelope(text)) {
    return parseJson(decryptSiksAuthEntity(text, appKey));
  }
  return parsed ?? text;
}

export function siksAuthFormData(payload, appKey) {
  const form = new FormData();
  form.append('entity', encryptSiksAuthEntity(JSON.stringify(payload), appKey));
  return form;
}

function authKey(appKey) {
  const key = Buffer.from(String(appKey || '').replace(/^base64:/, ''), 'base64');
  if (key.length !== 32) {
    throw new Error('SIKS auth app key harus berupa base64 key 32 byte.');
  }
  return key;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function isLikelyAuthEnvelope(value) {
  const decoded = Buffer.from(String(value || ''), 'base64').toString('utf8');
  return decoded.includes('"iv"') && decoded.includes('"value"') && decoded.includes('"mac"');
}

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
