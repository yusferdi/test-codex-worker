# Worker Auth Alternatives

Status saat ini:

- Worker utama tetap memakai Puppeteer.
- Puppeteer dipakai untuk login SIKS, captcha, OTP Telegram, membuka halaman DTSEN, dan menangkap `Authorization` dari request browser.
- Setelah `Authorization` tertangkap, pengecekan DTSEN sudah memakai HTTP langsung lewat `fetch`, `FormData`, dan payload `entity` terenkripsi AES-GCM.

Artinya bottleneck Puppeteer ada di tahap auth/session, bukan di query DTSEN per baris.

## Eksperimen yang ditambahkan

File:

- `worker/src/siksHttpAuthClient.js`
- `worker/src/siksAuthCrypto.js`
- `worker/src/siksSpaAuthClient.js`
- `worker/experimental/http-login-probe.mjs`
- `worker/experimental/spa-auth-probe.mjs`
- `worker/experimental/SiksHttpAuthClient.php`
- `worker/experimental/SiksSpaAuthClient.php`
- `worker/experimental/siks-http-login-probe.php`
- `worker/experimental/siks-spa-auth-probe.php`
- `worker/experimental/siks-login-only.mjs`
- `worker/experimental/siks-login-only.php`
- `worker/experimental/puppeteer-login-observer.mjs`

Keduanya mencoba pola yang sama:

1. GET halaman login.
2. Simpan cookie `Set-Cookie`.
3. Ekstrak form, hidden field, dan kandidat captcha.
4. Opsional POST login memakai cookie jar yang sama.

Default probe adalah `inspect-only`, jadi tidak mengirim username/password.

Audit bundle `https://siks.kemensos.go.id/static/js/main.9c2af8b1.js` juga menemukan jalur SPA yang lebih realistis:

- `https://api.kemensos.go.id/siks/auth/v1/login`
- `https://api.kemensos.go.id/siks/auth/v1/get-captcha`
- `https://api.kemensos.go.id/siks/auth/v1/matching-otp`
- `https://api.kemensos.go.id/siks/auth/v1/resend-otp`
- `https://api.kemensos.go.id/siks/auth/v1/get-profile`

Jalur auth SPA memakai AES-256-CBC + PKCS7 + HMAC wrapper (`iv`, `value`, `mac`) yang dibase64. Ini berbeda dari DTSEN data API yang saat ini memakai AES-GCM.

## Node.js probe

```bash
cd worker
node experimental/http-login-probe.mjs
```

Output ringkas tampil di terminal, detail aman disimpan ke:

```text
worker/output/auth-probe/
```

Untuk submit manual setelah captcha diketahui:

```bash
cd worker
$env:SIKS_HTTP_LOGIN_ALLOW_SUBMIT="1"
$env:SIKS_HTTP_LOGIN_CAPTCHA="ABCD"
node experimental/http-login-probe.mjs --submit
```

Probe SPA/captcha endpoint:

```bash
cd worker
node experimental/spa-auth-probe.mjs
```

Login-only HTTP SPA, mengikuti flow bundle React:

```bash
cd worker
node experimental/siks-login-only.mjs
```

Default-nya hanya mengambil captcha endpoint dan tidak mengirim kredensial. Untuk submit:

```bash
cd worker
$env:SIKS_HTTP_LOGIN_ALLOW_SUBMIT="1"
$env:SIKS_HTTP_LOGIN_CAPTCHA="ABCD"
node experimental/siks-login-only.mjs --submit
```

Submit login SPA manual:

```bash
cd worker
$env:SIKS_HTTP_LOGIN_ALLOW_SUBMIT="1"
$env:SIKS_HTTP_LOGIN_CAPTCHA="ABCD"
node experimental/spa-auth-probe.mjs --submit
```

## PHP probe

```bash
cd worker
php experimental/siks-http-login-probe.php
```

Submit manual:

```bash
cd worker
$env:SIKS_HTTP_LOGIN_ALLOW_SUBMIT="1"
$env:SIKS_HTTP_LOGIN_CAPTCHA="ABCD"
php experimental/siks-http-login-probe.php --submit
```

Probe SPA/captcha endpoint:

```bash
cd worker
php experimental/siks-spa-auth-probe.php
```

Login-only PHP:

```bash
cd worker
php experimental/siks-login-only.php
```

Submit login PHP:

```bash
cd worker
$env:SIKS_HTTP_LOGIN_ALLOW_SUBMIT="1"
$env:SIKS_HTTP_LOGIN_CAPTCHA="ABCD"
php experimental/siks-login-only.php --submit
```

## Observer Puppeteer untuk mempelajari request login

Script ini membuka halaman login dengan Puppeteer dan menyimpan request/response auth yang sudah disensor:

```bash
cd worker
node experimental/puppeteer-login-observer.mjs --headless --duration=15000
```

Untuk observasi manual, jalankan `--headed` lalu login sendiri di browser yang terbuka:

```bash
cd worker
node experimental/puppeteer-login-observer.mjs --headed --duration=60000
```

Output aman disimpan ke `worker/output/auth-probe/`. Header `authorization`, `cookie`, field password/captcha/otp, dan token disensor.

## OTP Telegram tanpa Puppeteer

Login-only HTTP menyediakan beberapa sumber OTP:

- `SIKS_OTP` atau `SIKS_HTTP_LOGIN_OTP` untuk OTP manual.
- `TELEGRAM_OTP_FILE` untuk file berisi pesan OTP terbaru.
- `TELEGRAM_TDLIB_OTP_COMMAND` untuk memanggil bridge TDLib lokal yang mengeluarkan pesan OTP ke stdout.
- `TELEGRAM_OTP_API_URL` untuk bridge HTTP internal.

Dengan begitu TDLib bisa dipasang sebagai proses terpisah, sementara worker HTTP login cukup membaca hasil akhirnya.

## Kenapa belum langsung mengganti Puppeteer?

Login SIKS kemungkinan SPA/React dan bisa melibatkan:

- captcha berbasis data URI atau endpoint dinamis,
- CSRF/hidden field,
- cookie HttpOnly,
- OTP,
- token `Authorization` yang dibuat oleh JavaScript setelah halaman DTSEN dibuka,
- kemungkinan device/session fingerprint.

Kalau token authorization dibuat di client-side setelah bundle JS berjalan, HTTP murni harus meniru request internal yang tepat. Probe ini dibuat untuk mengumpulkan fakta itu dulu tanpa merusak worker yang sudah jalan.

## Rencana migrasi aman

1. `SIKS_AUTH_MODE=puppeteer` tetap default.
2. Tambah `SIKS_AUTH_MODE=http-probe` untuk audit endpoint tanpa submit kredensial.
3. Setelah endpoint login dan OTP valid diketahui, tambah `SIKS_AUTH_MODE=http`.
4. Worker mencoba HTTP auth terlebih dahulu.
5. Jika HTTP auth gagal menangkap `Authorization`, fallback otomatis ke Puppeteer.
6. Puppeteer baru dihapus hanya jika HTTP auth stabil untuk captcha, OTP, cookies, dan token refresh.

## Kontrak session yang perlu dicapai

Alternatif HTTP dianggap siap menggantikan Puppeteer jika dapat menghasilkan:

```json
{
  "authorization": "Bearer ...",
  "cookies": "cookie=value; ...",
  "expiresAt": "ISO-8601",
  "source": "http"
}
```

Selama kontrak ini belum stabil, worker utama sebaiknya tetap memakai `SiksChecker` Puppeteer.
