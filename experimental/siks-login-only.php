<?php

declare(strict_types=1);

require_once __DIR__ . '/SiksSpaAuthClient.php';

function load_env_file(string $path): void
{
    if (!is_file($path)) {
        return;
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#') || !str_contains($trimmed, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $trimmed, 2);
        $key = trim($key);
        $value = trim($value, " \t\n\r\0\x0B\"'");
        if (getenv($key) === false) {
            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
        }
    }
}

function arg_value(array $argv, string $name): string
{
    $prefix = '--' . $name . '=';
    foreach ($argv as $arg) {
        if (str_starts_with($arg, $prefix)) {
            return trim(substr($arg, strlen($prefix)));
        }
    }
    return '';
}

function json_env(string $name): array
{
    $raw = getenv($name) ?: '';
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function response_shape($value)
{
    if (!is_array($value)) {
        return gettype($value);
    }
    $out = [];
    foreach (array_slice($value, 0, 16) as $key => $item) {
        $out[$key] = is_string($item) ? 'string:' . strlen($item) : (is_array($item) ? 'array:' . count($item) : gettype($item));
    }
    return $out;
}

function auth_data($data): array
{
    if (!is_array($data)) {
        return [];
    }
    $candidates = [
        $data['data']['data']['data'] ?? null,
        $data['data']['data'] ?? null,
        $data['data'] ?? null,
        $data,
    ];
    foreach ($candidates as $candidate) {
        if (is_array($candidate)) {
            return $candidate;
        }
    }
    return [];
}

function requires_otp($data): bool
{
    $auth = auth_data($data);
    return strtolower((string) ($auth['code'] ?? '')) === 'otp_req';
}

function summarize_login($data, string $authorization): array
{
    $auth = auth_data($data);
    return [
        'ok' => $authorization !== '',
        'code' => (string) ($auth['code'] ?? ($data['code'] ?? '')),
        'status' => $data['status'] ?? $data['success'] ?? null,
        'message' => (string) ($data['message'] ?? ($data['data']['message'] ?? '')),
        'authType' => (string) ($auth['jenis_autentikasi'] ?? ''),
        'requiresOtp' => requires_otp($data),
        'authorizationCaptured' => $authorization !== '',
        'shape' => response_shape($data),
    ];
}

function summarize_response($data): array
{
    if (is_array($data) && isset($data['error'])) {
        return ['error' => $data['error']];
    }
    return [
        'code' => is_array($data) ? (string) ($data['code'] ?? '') : '',
        'status' => is_array($data) ? ($data['status'] ?? $data['success'] ?? null) : null,
        'message' => is_array($data) ? (string) ($data['message'] ?? '') : '',
        'shape' => response_shape($data),
    ];
}

function match_otp(string $text, string $prefix = 'Kode OTP:'): string
{
    if ($prefix !== '') {
        $idx = strripos($text, $prefix);
        if ($idx !== false) {
            $slice = substr($text, $idx + strlen($prefix));
            if (preg_match('/\b(\d{4,8})\b/', $slice, $match)) {
                return $match[1];
            }
        }
    }
    preg_match_all('/\b(\d{4,8})\b/', $text, $matches);
    return $matches[1] ? end($matches[1]) : '';
}

function resolve_otp(array $argv): string
{
    $direct = arg_value($argv, 'otp') ?: (getenv('SIKS_OTP') ?: (getenv('SIKS_HTTP_LOGIN_OTP') ?: ''));
    if ($direct !== '') {
        return match_otp($direct, getenv('TELEGRAM_OTP_PREFIX') ?: 'Kode OTP:');
    }

    $file = getenv('TELEGRAM_OTP_FILE') ?: '';
    if ($file !== '' && is_file($file)) {
        $otp = match_otp((string) file_get_contents($file), getenv('TELEGRAM_OTP_PREFIX') ?: 'Kode OTP:');
        if ($otp !== '') {
            return $otp;
        }
    }

    $command = getenv('TELEGRAM_TDLIB_OTP_COMMAND') ?: '';
    if ($command !== '') {
        $output = shell_exec($command);
        $otp = match_otp((string) $output, getenv('TELEGRAM_OTP_PREFIX') ?: 'Kode OTP:');
        if ($otp !== '') {
            return $otp;
        }
    }

    $url = getenv('TELEGRAM_OTP_API_URL') ?: '';
    if ($url !== '') {
        $headers = [];
        $token = getenv('TELEGRAM_OTP_API_TOKEN') ?: '';
        if ($token !== '') {
            $headers[] = 'Authorization: Bearer ' . $token;
        }
        $context = stream_context_create(['http' => ['header' => implode("\r\n", $headers), 'timeout' => 30]]);
        $body = @file_get_contents($url, false, $context);
        $otp = match_otp((string) $body, getenv('TELEGRAM_OTP_PREFIX') ?: 'Kode OTP:');
        if ($otp !== '') {
            return $otp;
        }
    }

    return '';
}

function redact_for_storage($value)
{
    if (!is_array($value)) {
        return $value;
    }
    $out = [];
    foreach ($value as $key => $item) {
        if (is_string($item) && preg_match('/password|authorization|token|secret|captcha|otp/i', (string) $key) && $item !== '') {
            $out[$key] = '[redacted]';
        } else {
            $out[$key] = redact_for_storage($item);
        }
    }
    return $out;
}

$workerRoot = dirname(__DIR__);
load_env_file(getcwd() . DIRECTORY_SEPARATOR . '.env');
load_env_file(getcwd() . DIRECTORY_SEPARATOR . '.env.local');
load_env_file($workerRoot . DIRECTORY_SEPARATOR . '.env');
load_env_file($workerRoot . DIRECTORY_SEPARATOR . '.env.local');

$config = [
    'base_url' => getenv('SIKS_AUTH_API_BASE_URL') ?: 'https://api.kemensos.go.id',
    'app_key' => getenv('DTSEN_APP_KEY') ?: 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=',
    'username' => getenv('SIKS_USERNAME') ?: '',
    'login_endpoint' => getenv('SIKS_AUTH_LOGIN_ENDPOINT') ?: '/siks/auth/v1/login',
    'captcha_endpoint' => getenv('SIKS_AUTH_CAPTCHA_ENDPOINT') ?: '/siks/auth/v1/get-captcha',
    'matching_otp_endpoint' => getenv('SIKS_AUTH_MATCHING_OTP_ENDPOINT') ?: '/siks/auth/v1/matching-otp',
    'resend_otp_endpoint' => getenv('SIKS_AUTH_RESEND_OTP_ENDPOINT') ?: '/siks/auth/v1/resend-otp',
    'profile_endpoint' => getenv('SIKS_AUTH_PROFILE_ENDPOINT') ?: '/siks/auth/v1/get-profile',
    'username_field' => getenv('SIKS_HTTP_LOGIN_USERNAME_FIELD') ?: 'email',
    'timeout_seconds' => max(1, (int) (getenv('SIKS_LOGIN_ONLY_TIMEOUT_SECONDS') ?: 15)),
];

$client = new SiksSpaAuthClient($config);
$submit = in_array('--submit', $argv, true) || getenv('SIKS_HTTP_LOGIN_ALLOW_SUBMIT') === '1';
$summary = [
    'ok' => true,
    'mode' => $submit ? 'login-only' : 'captcha-only',
    'captcha' => null,
    'login' => null,
    'otp' => null,
    'profile' => null,
    'session' => null,
    'notes' => [],
    'time' => date('c'),
];

try {
    $summary['captcha'] = summarize_response($client->getCaptcha());
} catch (Throwable $e) {
    $summary['ok'] = false;
    $summary['captcha'] = ['error' => $e->getMessage()];
}

if ($submit) {
    $captcha = arg_value($argv, 'captcha') ?: (getenv('SIKS_HTTP_LOGIN_CAPTCHA') ?: '');
    if ($captcha === '') {
        $summary['login'] = [
            'skipped' => true,
            'reason' => 'Captcha belum diisi. Jalankan dengan --captcha=ABCD atau env SIKS_HTTP_LOGIN_CAPTCHA.',
        ];
    } else {
        try {
            $login = $client->login(getenv('SIKS_USERNAME') ?: '', getenv('SIKS_PASSWORD') ?: '', $captcha, json_env('SIKS_LOGIN_EXTRA_JSON'));
            $summary['login'] = summarize_login($login['data'], (string) ($login['authorization'] ?? ''));
            if (requires_otp($login['data'])) {
                $otp = resolve_otp($argv);
                if ($otp === '') {
                    $summary['otp'] = [
                        'skipped' => true,
                        'reason' => 'Login meminta OTP, tetapi OTP belum tersedia dari env/file/command/API.',
                    ];
                } else {
                    $extra = array_merge(json_env('SIKS_OTP_EXTRA_JSON'), ['type' => getenv('SIKS_OTP_PAYLOAD_TYPE') ?: 'sendotp']);
                    $otpResult = $client->matchingOtp($otp, getenv('SIKS_USERNAME') ?: '', $extra);
                    $summary['otp'] = summarize_login($otpResult['data'], (string) ($otpResult['authorization'] ?? ''));
                }
            }
            $hasFinalToken = $client->authorization() !== '' && !($summary['otp']['skipped'] ?? false);
            if ($hasFinalToken) {
                $profile = $client->getProfile();
                $summary['profile'] = summarize_response($profile);
                $summary['session'] = [
                    'authorization' => getenv('SIKS_LOGIN_ONLY_SAVE_TOKEN') === '1' ? '[saved-by-client]' : '[redacted]',
                    'authorizationCaptured' => true,
                    'cookies' => '',
                    'expiresAt' => '',
                    'source' => 'http-spa-login-only-php',
                ];
            }
        } catch (Throwable $e) {
            $summary['ok'] = false;
            $summary['login'] = ['ok' => false, 'error' => $e->getMessage()];
        }
    }
} else {
    $summary['notes'][] = 'Mode default hanya mengambil captcha endpoint dan tidak mengirim kredensial.';
}

$outDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'output' . DIRECTORY_SEPARATOR . 'auth-probe';
if (!is_dir($outDir)) {
    mkdir($outDir, 0775, true);
}
$outPath = $outDir . DIRECTORY_SEPARATOR . 'php-siks-login-only-' . time() . '.json';
file_put_contents($outPath, json_encode(redact_for_storage($summary), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

echo json_encode([
    'ok' => $summary['ok'],
    'output' => $outPath,
    'mode' => $summary['mode'],
    'captcha' => $summary['captcha'],
    'login' => isset($summary['login']) ? [
        'skipped' => (bool) ($summary['login']['skipped'] ?? false),
        'requiresOtp' => (bool) ($summary['login']['requiresOtp'] ?? false),
        'authorizationCaptured' => (bool) ($summary['login']['authorizationCaptured'] ?? false),
        'code' => $summary['login']['code'] ?? '',
        'error' => $summary['login']['error'] ?? '',
    ] : null,
    'otp' => isset($summary['otp']) ? [
        'skipped' => (bool) ($summary['otp']['skipped'] ?? false),
        'authorizationCaptured' => (bool) ($summary['otp']['authorizationCaptured'] ?? false),
        'code' => $summary['otp']['code'] ?? '',
        'error' => $summary['otp']['error'] ?? '',
    ] : null,
    'sessionReady' => (bool) ($summary['session']['authorizationCaptured'] ?? false),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
