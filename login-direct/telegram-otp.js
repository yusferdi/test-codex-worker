import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CACHE_DIR = ".siks";
const LOG_DIR = `${CACHE_DIR}/logs`;
const DEFAULT_SESSION_FILE = `${CACHE_DIR}/telegram.session`;

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

function envEnabled(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

async function writeJsonLog(name, data) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(`${LOG_DIR}/${stamp}-${name}.json`, JSON.stringify(data, null, 2));
}

async function readTelegramSession() {
  try {
    return await fs.readFile(telegramSessionFile(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function saveTelegramSession(session) {
  const file = telegramSessionFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, session, "utf8");
}

async function ensureTelegramConfig(rl) {
  const updates = {};
  if (!process.env.TELEGRAM_API_ID) {
    updates.TELEGRAM_API_ID = await rl.question("Telegram API ID: ");
  }
  if (!process.env.TELEGRAM_API_HASH) {
    updates.TELEGRAM_API_HASH = await rl.question("Telegram API HASH: ");
  }
  if (!process.env.TELEGRAM_PHONE) {
    updates.TELEGRAM_PHONE = await rl.question("Telegram phone (+62...): ");
  }
  if (!process.env.TELEGRAM_OTP_CHAT) {
    const chat = await rl.question("Chat bot OTP, username/id, kosongkan untuk scan recent chats: ");
    if (chat) updates.TELEGRAM_OTP_CHAT = chat;
  }
  updates.TELEGRAM_ENABLED = "1";

  if (Object.keys(updates).length) {
    await upsertEnvFile(updates);
    Object.assign(process.env, updates);
  }
}

async function createTelegramClient({ rl, allowLogin = false } = {}) {
  await loadEnvFile();
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const phone = process.env.TELEGRAM_PHONE;

  if (!apiId || !apiHash || !phone) {
    throw new Error("Konfigurasi Telegram belum lengkap. Jalankan: npm run telegram:setup");
  }

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const session = new StringSession(await readTelegramSession());
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

  await client.connect();
  if (!(await client.isUserAuthorized())) {
    if (!allowLogin) {
      await client.disconnect();
      throw new Error("Session Telegram belum ada. Jalankan dulu: npm run telegram:setup");
    }
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => await rl.question("Kode login Telegram: "),
      password: async () => await rl.question("Password 2FA Telegram, jika diminta: "),
      onError: (error) => console.error(error.message),
    });
    await saveTelegramSession(client.session.save());
  }

  return client;
}

function messageTimeMs(message) {
  if (!message?.date) return 0;
  if (message.date instanceof Date) return message.date.getTime();
  if (typeof message.date === "number") {
    return message.date < 1_000_000_000_000 ? message.date * 1000 : message.date;
  }
  return new Date(message.date).getTime();
}

function extractOtp(text) {
  const pattern = process.env.TELEGRAM_OTP_REGEX || "\\b\\d{6}\\b";
  const match = String(text || "").match(new RegExp(pattern));
  return match?.[1] || match?.[0] || null;
}

async function getRecentMessages(client, limit) {
  const chat = process.env.TELEGRAM_OTP_CHAT;
  if (chat) {
    const entity = await client.getEntity(chat);
    return await client.getMessages(entity, { limit });
  }

  const dialogs = await client.getDialogs({ limit: Number(process.env.TELEGRAM_DIALOG_LIMIT || 20) });
  const messages = [];
  for (const dialog of dialogs) {
    const recent = await client.getMessages(dialog.entity, { limit: 3 });
    messages.push(...recent);
  }
  return messages;
}

export function isTelegramOtpEnabled() {
  return envEnabled("TELEGRAM_ENABLED");
}

export async function readOtpFromTelegram({ since = new Date(), rl, excludedOtps = new Set() } = {}) {
  await loadEnvFile();
  if (!isTelegramOtpEnabled()) return null;

  const excluded = normalizeExcludedOtps(excludedOtps);
  const timeoutMs = Number(process.env.TELEGRAM_OTP_TIMEOUT_MS || 60000);
  const intervalMs = Number(process.env.TELEGRAM_OTP_INTERVAL_MS || 3000);
  const limit = Number(process.env.TELEGRAM_OTP_LIMIT || 15);
  const sinceMs = since.getTime() - 30000;
  const deadline = Date.now() + timeoutMs;
  const client = await createTelegramClient({ rl, allowLogin: false });

  try {
    await writeJsonLog("telegram-otp-request", {
      chat: process.env.TELEGRAM_OTP_CHAT || null,
      since: new Date(sinceMs).toISOString(),
      excluded_count: excluded.size,
      timeoutMs,
      intervalMs,
      limit,
    });

    while (Date.now() < deadline) {
      const messages = await getRecentMessages(client, limit);
      const candidates = messages
        .map((message) => ({
          id: message.id,
          date: messageTimeMs(message),
          text: message.message || message.text || "",
        }))
        .filter((message) => message.date >= sinceMs)
        .sort((a, b) => b.date - a.date);

      for (const message of candidates) {
        const otp = extractOtp(message.text);
        if (otp && !excluded.has(otp)) {
          await writeJsonLog("telegram-otp-response", {
            status: "found",
            otp,
            message,
          });
          return otp;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    await writeJsonLog("telegram-otp-response", {
      status: "timeout",
    });
    return null;
  } finally {
    await client.disconnect();
  }
}

export async function setupTelegram(rl) {
  await loadEnvFile();
  await ensureTelegramConfig(rl);
  const client = await createTelegramClient({ rl, allowLogin: true });
  await saveTelegramSession(client.session.save());
  await client.disconnect();
}

async function main() {
  const command = process.argv[2] || "setup";
  const rl = createInterface({ input, output });
  try {
    if (command === "setup") {
      await setupTelegram(rl);
      console.log(`Telegram session tersimpan di ${telegramSessionFile()}`);
      return;
    }
    if (command === "test") {
      const otp = await readOtpFromTelegram({ since: new Date(Date.now() - 10 * 60 * 1000), rl });
      console.log(otp ? `OTP ditemukan: ${otp}` : "OTP tidak ditemukan.");
      return;
    }
    throw new Error(`Command tidak dikenal: ${command}`);
  } finally {
    rl.close();
  }
}

function telegramSessionFile() {
  return process.env.TELEGRAM_SESSION_FILE || DEFAULT_SESSION_FILE;
}

function normalizeExcludedOtps(excludedOtps) {
  if (!excludedOtps) {
    return new Set();
  }
  if (excludedOtps instanceof Set) {
    return new Set(Array.from(excludedOtps).map(value => String(value)));
  }
  if (Array.isArray(excludedOtps)) {
    return new Set(excludedOtps.map(value => String(value)));
  }
  return new Set([String(excludedOtps)]);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
