<?php

declare(strict_types=1);

final class SiksSpaAuthCrypto
{
    public static function encryptEntity(string $plainText, string $appKey): string
    {
        $key = self::key($appKey);
        $iv = random_bytes(16);
        $encrypted = openssl_encrypt($plainText, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
        if ($encrypted === false) {
            throw new RuntimeException('Gagal encrypt auth entity SIKS.');
        }
        $ivBase64 = base64_encode($iv);
        $value = base64_encode($encrypted);
        $mac = hash_hmac('sha256', $ivBase64 . $value, $key);
        return base64_encode(json_encode([
            'iv' => $ivBase64,
            'value' => $value,
            'mac' => $mac,
        ], JSON_UNESCAPED_SLASHES));
    }

    public static function decryptEntity(string $payload, string $appKey): string
    {
        $key = self::key($appKey);
        $envelope = json_decode(base64_decode($payload, true) ?: '', true);
        if (!is_array($envelope) || empty($envelope['iv']) || empty($envelope['value']) || empty($envelope['mac'])) {
            throw new RuntimeException('Envelope auth SIKS tidak lengkap.');
        }
        $expectedMac = hash_hmac('sha256', (string) $envelope['iv'] . (string) $envelope['value'], $key);
        if (!hash_equals($expectedMac, (string) $envelope['mac'])) {
            throw new RuntimeException('MAC auth SIKS tidak valid.');
        }
        $plain = openssl_decrypt(
            base64_decode((string) $envelope['value'], true) ?: '',
            'AES-256-CBC',
            $key,
            OPENSSL_RAW_DATA,
            base64_decode((string) $envelope['iv'], true) ?: ''
        );
        if ($plain === false) {
            throw new RuntimeException('Gagal decrypt auth entity SIKS.');
        }
        return $plain;
    }

    /**
     * @return mixed
     */
    public static function decodeResponse(string $rawText, string $appKey)
    {
        $text = trim($rawText);
        if ($text === '') {
            return null;
        }
        $json = json_decode($text, true);
        if (is_string($json) && self::looksLikeEnvelope($json)) {
            return json_decode(self::decryptEntity($json, $appKey), true);
        }
        if (is_array($json)) {
            if (isset($json['data']) && is_string($json['data']) && self::looksLikeEnvelope($json['data'])) {
                $json['data'] = json_decode(self::decryptEntity($json['data'], $appKey), true);
            }
            return $json;
        }
        if (self::looksLikeEnvelope($text)) {
            return json_decode(self::decryptEntity($text, $appKey), true);
        }
        return $json ?? $text;
    }

    private static function looksLikeEnvelope(string $value): bool
    {
        $decoded = base64_decode($value, true);
        return is_string($decoded) && str_contains($decoded, '"iv"') && str_contains($decoded, '"value"') && str_contains($decoded, '"mac"');
    }

    private static function key(string $appKey): string
    {
        $key = base64_decode(preg_replace('/^base64:/', '', $appKey) ?? '', true);
        if (!is_string($key) || strlen($key) !== 32) {
            throw new RuntimeException('SIKS auth app key harus berupa base64 key 32 byte.');
        }
        return $key;
    }
}

final class SiksSpaAuthClient
{
    private string $token = '';

    /**
     * @param array<string, mixed> $config
     */
    public function __construct(private array $config)
    {
        $this->config['base_url'] = rtrim((string) ($config['base_url'] ?? 'https://api.kemensos.go.id'), '/');
        $this->config['app_key'] = (string) ($config['app_key'] ?? 'base64:DuwlELKGgZKS0EO64/5ROG0UEy84IiebaIoNLAi0bFU=');
        $this->config['timeout_seconds'] = max(1, (int) ($config['timeout_seconds'] ?? 15));
    }

    /**
     * @return array<string, mixed>
     */
    public function login(string $username, string $password, string $captcha = '', array $extra = []): array
    {
        $usernameField = (string) ($this->config['username_field'] ?? 'email');
        $payload = array_merge([
            $usernameField => $username,
            'password' => $password,
            'captcha' => $captcha,
        ], $extra);
        $data = $this->request('POST', (string) ($this->config['login_endpoint'] ?? '/siks/auth/v1/login'), $payload);
        $this->token = $this->extractToken($data) ?: $this->token;
        return ['data' => $data, 'authorization' => $this->token];
    }

    /**
     * @return array<string, mixed>
     */
    public function matchingOtp(string $otp, string $email = '', array $extra = []): array
    {
        $payload = array_merge([
            'email' => $email ?: (string) ($this->config['username'] ?? ''),
            'otp' => $otp,
            'type' => 'sendotp',
        ], $extra);
        $data = $this->request('POST', (string) ($this->config['matching_otp_endpoint'] ?? '/siks/auth/v1/matching-otp'), $payload);
        $this->token = $this->extractToken($data) ?: $this->token;
        return ['data' => $data, 'authorization' => $this->token];
    }

    /**
     * @return array<string, mixed>
     */
    public function resendOtp(string $email = '', array $extra = []): array
    {
        $payload = array_merge([
            'email' => $email ?: (string) ($this->config['username'] ?? ''),
            'type' => 'resendotp',
        ], $extra);
        $data = $this->request('POST', (string) ($this->config['resend_otp_endpoint'] ?? '/siks/auth/v1/resend-otp'), $payload);
        $this->token = $this->extractToken($data) ?: $this->token;
        return ['data' => $data, 'authorization' => $this->token];
    }

    /**
     * @return mixed
     */
    public function getCaptcha()
    {
        return $this->request('GET', (string) ($this->config['captcha_endpoint'] ?? '/siks/auth/v1/get-captcha'));
    }

    /**
     * @return mixed
     */
    public function getProfile()
    {
        return $this->request('GET', (string) ($this->config['profile_endpoint'] ?? '/siks/auth/v1/get-profile'));
    }

    public function authorization(): string
    {
        return $this->token;
    }

    /**
     * @return mixed
     */
    private function request(string $method, string $endpoint, ?array $payload = null)
    {
        $url = str_starts_with($endpoint, 'http') ? $endpoint : $this->config['base_url'] . '/' . ltrim($endpoint, '/');
        $headers = [
            'Accept: application/json, text/plain, */*',
            'Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent: Mozilla/5.0 KAT-Worker-PhpSpaAuthProbe/1.0',
            'Origin: https://siks.kemensos.go.id',
            'Referer: https://siks.kemensos.go.id/login',
        ];
        $body = '';
        if ($payload !== null && strtoupper($method) !== 'GET') {
            $headers[] = 'Content-Type: multipart/form-data';
            $body = http_build_query([
                'entity' => SiksSpaAuthCrypto::encryptEntity(json_encode($payload, JSON_UNESCAPED_SLASHES), $this->config['app_key']),
            ]);
            $headers[count($headers) - 1] = 'Content-Type: application/x-www-form-urlencoded';
        }
        if ($this->token !== '') {
            $headers[] = 'authorization: ' . $this->token;
        }

        $context = stream_context_create([
            'http' => [
                'method' => strtoupper($method),
                'header' => implode("\r\n", $headers),
                'content' => $body,
                'timeout' => $this->config['timeout_seconds'],
                'ignore_errors' => true,
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
        if ($raw === false) {
            $status = 0;
            foreach (($http_response_header ?? []) as $line) {
                if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $match)) {
                    $status = (int) $match[1];
                    break;
                }
            }
            throw new RuntimeException('SIKS auth API gagal tanpa response' . ($status ? ' (HTTP ' . $status . ')' : '') . '.');
        }
        return SiksSpaAuthCrypto::decodeResponse($raw, $this->config['app_key']);
    }

    private function extractToken($data): string
    {
        $candidates = [
            $data['data']['data']['access_token'] ?? '',
            $data['data']['data']['data'] ?? '',
            $data['data']['access_token'] ?? '',
            $data['access_token'] ?? '',
            $data['token'] ?? '',
            $data['data'] ?? '',
        ];
        foreach ($candidates as $candidate) {
            $value = trim((string) $candidate);
            if (str_starts_with($value, 'Bearer ') || strlen($value) > 40) {
                return $value;
            }
        }
        return '';
    }
}
