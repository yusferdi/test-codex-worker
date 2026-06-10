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

$workerRoot = dirname(__DIR__);
load_env_file(getcwd() . DIRECTORY_SEPARATOR . '.env');
load_env_file(getcwd() . DIRECTORY_SEPARATOR . '.env.local');
load_env_file($workerRoot . DIRECTORY_SEPARATOR . '.env');
load_env_file($workerRoot . DIRECTORY_SEPARATOR . '.env.local');

$config = [
    'base_url' => getenv('SIKS_AUTH_API_BASE_URL') ?: 'https://api.kemensos.go.id',
    'app_key' => getenv('DTSEN_APP_KEY') ?: 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=',
    'login_endpoint' => getenv('SIKS_AUTH_LOGIN_ENDPOINT') ?: '/siks/auth/v1/login',
    'captcha_endpoint' => getenv('SIKS_AUTH_CAPTCHA_ENDPOINT') ?: '/siks/auth/v1/get-captcha',
    'username_field' => getenv('SIKS_HTTP_LOGIN_USERNAME_FIELD') ?: 'email',
    'timeout_seconds' => 15,
];

$client = new SiksSpaAuthClient($config);
$submit = in_array('--submit', $argv, true) || getenv('SIKS_HTTP_LOGIN_ALLOW_SUBMIT') === '1';
$summary = [
    'mode' => $submit ? 'submit' : 'captcha-only',
    'captcha' => null,
];

try {
    $summary['captcha'] = $client->getCaptcha();
} catch (Throwable $e) {
    $summary['captcha'] = ['error' => $e->getMessage()];
}

if ($submit) {
    $captcha = getenv('SIKS_HTTP_LOGIN_CAPTCHA') ?: '';
    if ($captcha === '') {
        $summary['login'] = [
            'skipped' => true,
            'reason' => 'SIKS_HTTP_LOGIN_CAPTCHA kosong. Isi manual captcha dulu sebelum submit.',
        ];
    } else {
        try {
            $summary['login'] = $client->login(getenv('SIKS_USERNAME') ?: '', getenv('SIKS_PASSWORD') ?: '', $captcha);
            $summary['login']['authorization'] = !empty($summary['login']['authorization']) ? '[redacted]' : '';
        } catch (Throwable $e) {
            $summary['login'] = ['ok' => false, 'error' => $e->getMessage()];
        }
    }
}

$outDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'output' . DIRECTORY_SEPARATOR . 'auth-probe';
if (!is_dir($outDir)) {
    mkdir($outDir, 0775, true);
}
$outPath = $outDir . DIRECTORY_SEPARATOR . 'php-spa-auth-probe-' . time() . '.json';
file_put_contents($outPath, json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

echo json_encode([
    'ok' => true,
    'output' => $outPath,
    'mode' => $summary['mode'],
    'captchaShape' => is_array($summary['captcha']) ? array_slice(array_keys($summary['captcha']), 0, 12) : gettype($summary['captcha']),
    'login' => isset($summary['login']) ? [
        'skipped' => (bool) ($summary['login']['skipped'] ?? false),
        'ok' => (bool) ($summary['login']['authorization'] ?? false),
        'error' => $summary['login']['error'] ?? '',
    ] : null,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
