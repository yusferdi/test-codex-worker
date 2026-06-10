<?php

declare(strict_types=1);

require_once __DIR__ . '/SiksHttpAuthClient.php';

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
    'login_url' => getenv('SIKS_LOGIN_URL') ?: rtrim((string) (getenv('SIKS_BASE_URL') ?: 'https://siks.kemensos.go.id'), '/') . '/login',
    'username_selector' => getenv('SIKS_LOGIN_USERNAME_SELECTOR') ?: 'input[name="username"]',
    'password_selector' => getenv('SIKS_LOGIN_PASSWORD_SELECTOR') ?: 'input[name="password"]',
    'captcha_selector' => getenv('SIKS_LOGIN_CAPTCHA_SELECTOR') ?: 'input[name="captcha"]',
    'timeout_seconds' => max(1, (int) ((getenv('SIKS_ACTION_TIMEOUT_MS') ?: 15000) / 1000)),
];

$submit = in_array('--submit', $argv, true) || getenv('SIKS_HTTP_LOGIN_ALLOW_SUBMIT') === '1';
$client = new SiksHttpAuthClient($config);
$summary = [
    'mode' => $submit ? 'submit' : 'inspect-only',
    'loginUrl' => $config['login_url'],
    'page' => $client->getLoginPage(),
];

if ($submit) {
    $captcha = getenv('SIKS_HTTP_LOGIN_CAPTCHA') ?: '';
    if ($captcha === '') {
        $summary['submit'] = [
            'skipped' => true,
            'reason' => 'SIKS_HTTP_LOGIN_CAPTCHA kosong. Isi manual hasil captcha dulu.',
        ];
    } else {
        $summary['submit'] = $client->submitLogin([
            'username' => getenv('SIKS_USERNAME') ?: '',
            'password' => getenv('SIKS_PASSWORD') ?: '',
            'captcha' => $captcha,
        ]);
    }
}

$outDir = $workerRoot . DIRECTORY_SEPARATOR . 'output' . DIRECTORY_SEPARATOR . 'auth-probe';
if (!is_dir($outDir)) {
    mkdir($outDir, 0775, true);
}
$outPath = $outDir . DIRECTORY_SEPARATOR . 'php-http-login-probe-' . time() . '.json';
file_put_contents($outPath, json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

echo json_encode([
    'ok' => true,
    'output' => $outPath,
    'mode' => $summary['mode'],
    'status' => $summary['page']['status'] ?? null,
    'forms' => count($summary['page']['forms'] ?? []),
    'captchaCandidates' => count($summary['page']['captcha'] ?? []),
    'submit' => isset($summary['submit']) ? [
        'skipped' => (bool) ($summary['submit']['skipped'] ?? false),
        'status' => $summary['submit']['status'] ?? null,
        'ok' => (bool) ($summary['submit']['ok'] ?? false),
        'location' => $summary['submit']['location'] ?? '',
    ] : null,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
