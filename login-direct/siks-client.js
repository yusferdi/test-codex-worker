import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getCaptchaTextFromGemini } from "../src/captchaSolver.js";
import { readOtpFromTelegram } from "./telegram-otp.js";

const API_BASE = "https://api.kemensos.go.id/";
const DEFAULT_APP_KEY_B64 = "DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=";
const CACHE_DIR = ".siks";
const LOG_DIR = `${CACHE_DIR}/logs`;
const CAPTCHA_CACHE_FILE = `${CACHE_DIR}/captcha-response.json`;

async function loadEnvFile(file = ".env") {
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      process.env[key] ??= value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function upsertEnvFile(values, file = ".env") {
  let content = "";
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const existing = new Map();
  const order = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    existing.set(key, line.slice(index + 1).trim());
    order.push(key);
  }

  for (const [key, value] of Object.entries(values)) {
    if (!existing.has(key)) order.push(key);
    existing.set(key, String(value).replace(/\r?\n/g, ""));
  }

  const uniqueOrder = [...new Set(order)];
  await fs.writeFile(file, uniqueOrder.map((key) => `${key}=${existing.get(key)}`).join("\n") + "\n", "utf8");
}

async function saveCredentials(username, password) {
  await upsertEnvFile({
    SIKS_USERNAME: username,
    SIKS_PASSWORD: password,
  });
}

function shouldReuseCaptcha() {
  const value = process.env.SIKS_REUSE_CAPTCHA || "";
  return process.argv.includes("--reuse-captcha") || ["1", "true", "yes"].includes(value.toLowerCase());
}

function geminiConfigFromEnv() {
  const keys = uniqueList([
    process.env.GEMINI_API_KEY || "",
    ...listEnv("GEMINI_API_KEYS"),
  ]);
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiApiKeys: keys,
    geminiApiModel: process.env.GEMINI_API_MODEL || "gemini-2.5-flash",
    geminiGenerateUrlTemplate: process.env.GEMINI_GENERATE_URL_TEMPLATE || "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
    geminiRequestTimeoutMs: Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 30000),
    geminiKeyCooldownMs: Number(process.env.GEMINI_KEY_COOLDOWN_MS || 60000),
    captchaPattern: process.env.CAPTCHA_PATTERN || "([A-Z]{3}[0-9])",
    captchaLength: Number(process.env.CAPTCHA_LENGTH || 4),
  };
}

function decryptPayload(ciphertext) {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < 28) {
    throw new Error("Ciphertext terlalu pendek untuk format AES-GCM SIKS.");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", authAppKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function encryptPayload(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", authAppKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64");
}

function decodeResponse(json) {
  if (json && typeof json.data === "string") {
    return { ...json, data: JSON.parse(decryptPayload(json.data)) };
  }
  return json;
}

function toFormData(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.append(key, value);
    }
  }
  return form;
}

function toEncryptedFormData(fields) {
  const form = new FormData();
  form.append("entity", encryptPayload(JSON.stringify(fields)));
  return form;
}

async function writeJsonLog(name, data) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(`${LOG_DIR}/${stamp}-${name}.json`, JSON.stringify(data, null, 2));
}

async function readCaptchaCache() {
  try {
    return JSON.parse(await fs.readFile(CAPTCHA_CACHE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCaptchaCache(captchaData) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(CAPTCHA_CACHE_FILE, JSON.stringify(captchaData, null, 2));
}

async function api(path, { method = "GET", token = "", body, requestFields, logName } = {}) {
  const requestLog = {
    method,
    url: new URL(path, API_BASE).toString(),
    headers: token ? { authorization: token } : {},
    fields: requestFields,
  };
  if (logName) {
    await writeJsonLog(`${logName}-request`, requestLog);
  }

  const response = await fetch(new URL(path, API_BASE), {
    method,
    headers: token ? { authorization: token } : undefined,
    body,
  });

  const contentType = response.headers.get("content-type") || "";
  const raw = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  const data = typeof raw === "object" && raw !== null ? decodeResponse(raw) : raw;

  if (logName) {
    await writeJsonLog(`${logName}-response`, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: data,
    });
  }

  if (!response.ok) {
    const message = data?.message || data?.data?.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return data;
}

function findCaptchaImage(captchaData) {
  const candidates = [
    captchaData?.captcha,
    captchaData?.image,
    captchaData?.img,
    captchaData?.data,
    captchaData?.base64,
    captchaData?.url,
  ].filter(Boolean);

  return candidates.find((value) => typeof value === "string" && value.length > 30);
}

async function saveCaptcha(captchaData) {
  const image = findCaptchaImage(captchaData);
  if (!image) {
    console.log("Data captcha:", JSON.stringify(captchaData, null, 2));
    return null;
  }

  if (image.startsWith("data:image/")) {
    const [, meta, b64] = image.match(/^data:(image\/[^;]+);base64,(.+)$/) || [];
    if (!b64) return null;
    const ext = meta.includes("png") ? "png" : meta.includes("jpeg") ? "jpg" : "img";
    const file = `captcha.${ext}`;
    await fs.writeFile(file, Buffer.from(b64, "base64"));
    return file;
  }

  if (/^[A-Za-z0-9+/=]+$/.test(image)) {
    const file = "captcha.png";
    await fs.writeFile(file, Buffer.from(image, "base64"));
    return file;
  }

  if (/^https?:\/\//i.test(image) || image.startsWith("/")) {
    const url = new URL(image, API_BASE).toString();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download captcha HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") || "";
    const file = contentType.includes("jpeg") || contentType.includes("jpg") ? "captcha.jpg" : "captcha.png";
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    return file;
  }

  console.log("Captcha URL/string:", image);
  return null;
}

function authAppKey() {
  const raw = String(process.env.SIKS_AUTH_APP_KEY || process.env.DTSEN_APP_KEY || DEFAULT_APP_KEY_B64).replace(/^base64:/, "");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("SIKS auth app key harus berupa base64 key 32 byte.");
  }
  return key;
}

async function getCaptchaData({ reuse = false } = {}) {
  if (reuse) {
    await writeJsonLog("captcha-cache-request", {
      mode: "reuse",
      cacheFile: CAPTCHA_CACHE_FILE,
    });

    const cached = await readCaptchaCache();
    if (cached) {
      await writeJsonLog("captcha-cache-response", {
        status: "hit",
        body: cached,
      });
      return { captchaData: cached, fromCache: true };
    }

    await writeJsonLog("captcha-cache-response", {
      status: "miss",
      body: null,
    });
  }

  const captcha = await api("siks/auth/v1/get-captcha", { logName: "captcha" });
  const captchaData = captcha?.data?.data ?? captcha?.data ?? captcha;
  await writeCaptchaCache(captchaData);
  return { captchaData, fromCache: false };
}

function listEnv(name) {
  return String(process.env[name] || "")
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function main() {
  await loadEnvFile();

  const rl = createInterface({ input, output });

  try {
    const email = process.env.SIKS_USERNAME || await rl.question("Username/email: ");
    const password = process.env.SIKS_PASSWORD || await rl.question("Password: ");
    await saveCredentials(email, password);

    const { captchaData, fromCache } = await getCaptchaData({ reuse: shouldReuseCaptcha() });
    const captchaFile = await saveCaptcha(captchaData);
    if (captchaFile) {
      console.log(`Captcha disimpan di: ${captchaFile}${fromCache ? " (dari cache)" : ""}`);
    }

    const manualCaptcha = String(process.env.SIKS_HTTP_LOGIN_CAPTCHA || process.env.SIKS_CAPTCHA_TEXT || "").trim();
    if (!captchaFile && !manualCaptcha) {
      throw new Error("Captcha tidak bisa disimpan/dibaca, sehingga Gemini tidak bisa memprosesnya.");
    }
    const captchaText = manualCaptcha
      ? manualCaptcha.toUpperCase().replace(/[^A-Z0-9]/g, "")
      : await getCaptchaTextFromGemini(captchaFile, geminiConfigFromEnv());
    console.log(`Captcha ${manualCaptcha ? "manual" : "Gemini"}: ${captchaText}`);
    const loginPayload = {
      email,
      password,
      captcha: captchaText,
      key: captchaData?.key || captchaData?.captcha_key || captchaData?.id,
    };

    const loginStartedAt = new Date();
    const login = await api("siks/auth/v1/login", {
      method: "POST",
      body: toEncryptedFormData(loginPayload),
      requestFields: loginPayload,
      logName: "login",
    });
    const loginData = login?.data?.data ?? login?.data ?? login;

    let authorization = loginData?.access_token;
    if (loginData?.code === "otp_req") {
      const otpStageToken = loginData?.data;
      console.log(`OTP diminta via: ${loginData?.jenis_autentikasi || "unknown"}`);
      let otp = null;
      try {
        otp = await readOtpFromTelegram({ since: loginStartedAt, rl });
        if (otp) {
          console.log(`OTP Telegram terbaca otomatis: ${otp}`);
        }
      } catch (error) {
        console.log(`Auto baca Telegram dilewati: ${error.message}`);
      }

      if (!otp) {
        otp = await rl.question("Kode OTP: ");
      }

      const otpResponse = await api("siks/auth/v1/matching-otp", {
        method: "POST",
        token: otpStageToken,
        body: toEncryptedFormData({
          username: email,
          email,
          otp,
          type: "sendotp",
        }),
        requestFields: {
          username: email,
          email,
          otp,
          type: "sendotp",
        },
        logName: "otp",
      });
      const otpData = otpResponse?.data?.data ?? otpResponse?.data ?? otpResponse;
      authorization = otpData?.token || otpData?.access_token;
    }

    if (!authorization) {
      console.log("Login response:", JSON.stringify(loginData, null, 2));
      throw new Error("Token authorization tidak ditemukan di respons login/OTP.");
    }

    console.log("\nAuthorization header:");
    console.log(`authorization: ${authorization}`);

    const profile = await api("siks/auth/v1/get-profile", {
      token: authorization,
      logName: "profile",
    });
    console.log("\nProfile check berhasil:");
    console.log(JSON.stringify(profile?.data?.data ?? profile?.data ?? profile, null, 2));
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
