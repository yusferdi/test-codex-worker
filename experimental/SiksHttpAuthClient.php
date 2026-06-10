<?php

declare(strict_types=1);

final class SiksHttpCookieJar
{
    /** @var array<string, array<string, mixed>> */
    private array $cookies = [];

    /**
     * @param array<int, string> $headers
     */
    public function addFromHeaders(array $headers, string $baseUrl = ''): void
    {
        foreach ($headers as $header) {
            if (stripos($header, 'Set-Cookie:') !== 0) {
                continue;
            }
            $cookie = $this->parseCookie(trim(substr($header, 11)), $baseUrl);
            if ($cookie && $cookie['name'] !== '') {
                $this->cookies[$cookie['name']] = $cookie;
            }
        }
    }

    public function header(): string
    {
        $pairs = [];
        foreach ($this->cookies as $cookie) {
            $pairs[] = $cookie['name'] . '=' . $cookie['value'];
        }
        return implode('; ', $pairs);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function summary(): array
    {
        return array_map(static fn (array $cookie): array => [
            'name' => $cookie['name'],
            'domain' => $cookie['domain'],
            'path' => $cookie['path'],
            'secure' => $cookie['secure'],
            'httpOnly' => $cookie['httpOnly'],
            'value' => $cookie['value'] !== '' ? '[redacted]' : '',
        ], array_values($this->cookies));
    }

    /**
     * @return array<string, mixed>|null
     */
    private function parseCookie(string $value, string $baseUrl): ?array
    {
        $parts = array_map('trim', explode(';', $value));
        $nameValue = array_shift($parts);
        if (!$nameValue || !str_contains($nameValue, '=')) {
            return null;
        }
        [$name, $cookieValue] = explode('=', $nameValue, 2);
        $cookie = [
            'name' => $name,
            'value' => $cookieValue,
            'domain' => parse_url($baseUrl, PHP_URL_HOST) ?: '',
            'path' => '/',
            'secure' => false,
            'httpOnly' => false,
        ];
        foreach ($parts as $part) {
            [$key, $attrValue] = array_pad(explode('=', $part, 2), 2, '');
            $key = strtolower($key);
            if ($key === 'domain') {
                $cookie['domain'] = $attrValue;
            } elseif ($key === 'path') {
                $cookie['path'] = $attrValue !== '' ? $attrValue : '/';
            } elseif ($key === 'secure') {
                $cookie['secure'] = true;
            } elseif ($key === 'httponly') {
                $cookie['httpOnly'] = true;
            }
        }
        return $cookie;
    }
}

final class SiksHttpAuthClient
{
    private SiksHttpCookieJar $jar;
    private int $timeoutSeconds;
    private string $userAgent = 'Mozilla/5.0 KAT-Worker-PhpHttpAuthProbe/1.0';

    /**
     * @param array<string, mixed> $config
     */
    public function __construct(private array $config, ?SiksHttpCookieJar $jar = null)
    {
        $this->jar = $jar ?: new SiksHttpCookieJar();
        $this->timeoutSeconds = max(1, (int) (($config['timeout_seconds'] ?? 15)));
    }

    /**
     * @return array<string, mixed>
     */
    public function getLoginPage(): array
    {
        $response = $this->request((string) $this->config['login_url'], 'GET');
        $html = $response['body'];
        return [
            'url' => $response['url'],
            'status' => $response['status'],
            'ok' => $response['status'] >= 200 && $response['status'] < 400,
            'forms' => $this->extractForms($html, $response['url']),
            'captcha' => $this->extractCaptchaCandidates($html, $response['url']),
            'cookies' => $this->jar->summary(),
        ];
    }

    /**
     * @param array<string, string> $input
     * @return array<string, mixed>
     */
    public function submitLogin(array $input): array
    {
        $page = $this->getLoginPage();
        $form = $page['forms'][0] ?? [
            'action' => $this->config['login_url'],
            'method' => 'POST',
            'hidden' => [],
        ];
        $fields = array_merge($form['hidden'], [
            $this->fieldNameFromSelector((string) ($this->config['username_selector'] ?? ''), 'username') => $input['username'] ?? '',
            $this->fieldNameFromSelector((string) ($this->config['password_selector'] ?? ''), 'password') => $input['password'] ?? '',
            $this->fieldNameFromSelector((string) ($this->config['captcha_selector'] ?? ''), 'captcha') => $input['captcha'] ?? '',
        ], $input['extra'] ?? []);

        $response = $this->request((string) $form['action'], (string) ($form['method'] ?? 'POST'), [
            'Content-Type: application/x-www-form-urlencoded',
            'Referer: ' . $page['url'],
        ], http_build_query($fields), false);

        return [
            'status' => $response['status'],
            'ok' => $response['status'] >= 200 && $response['status'] < 400,
            'location' => $response['headers']['location'] ?? '',
            'cookies' => $this->jar->summary(),
            'bodyPreview' => substr($this->sanitizeText($response['body']), 0, 1200),
        ];
    }

    /**
     * @param array<int, string> $headers
     * @return array<string, mixed>
     */
    private function request(string $url, string $method = 'GET', array $headers = [], string $body = '', bool $follow = true): array
    {
        $cookie = $this->jar->header();
        $requestHeaders = array_merge([
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent: ' . $this->userAgent,
        ], $headers);
        if ($cookie !== '') {
            $requestHeaders[] = 'Cookie: ' . $cookie;
        }

        if (function_exists('curl_init')) {
            $receivedHeaders = [];
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => strtoupper($method),
                CURLOPT_HTTPHEADER => $requestHeaders,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => $follow,
                CURLOPT_TIMEOUT => $this->timeoutSeconds,
                CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$receivedHeaders): int {
                    $trimmed = trim($line);
                    if ($trimmed !== '') {
                        $receivedHeaders[] = $trimmed;
                    }
                    return strlen($line);
                },
            ]);
            if ($body !== '') {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }
            $responseBody = curl_exec($ch);
            if ($responseBody === false) {
                $error = curl_error($ch);
                curl_close($ch);
                throw new RuntimeException('HTTP auth request gagal: ' . $error);
            }
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $finalUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
            curl_close($ch);
            $this->jar->addFromHeaders($receivedHeaders, $url);
            return [
                'status' => $status,
                'url' => $finalUrl ?: $url,
                'headers' => $this->normalizeHeaders($receivedHeaders),
                'body' => (string) $responseBody,
            ];
        }

        $context = stream_context_create([
            'http' => [
                'method' => strtoupper($method),
                'header' => implode("\r\n", $requestHeaders),
                'content' => $body,
                'timeout' => $this->timeoutSeconds,
                'follow_location' => $follow ? 1 : 0,
                'ignore_errors' => true,
            ],
        ]);
        $responseBody = file_get_contents($url, false, $context);
        if ($responseBody === false) {
            throw new RuntimeException('HTTP auth request gagal tanpa response.');
        }
        $headersOut = $http_response_header ?? [];
        $this->jar->addFromHeaders($headersOut, $url);
        return [
            'status' => $this->statusFromHeaders($headersOut),
            'url' => $url,
            'headers' => $this->normalizeHeaders($headersOut),
            'body' => (string) $responseBody,
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function extractForms(string $html, string $baseUrl): array
    {
        preg_match_all('/<form\b[^>]*>[\s\S]*?<\/form>/i', $html, $matches);
        $forms = [];
        foreach ($matches[0] as $formHtml) {
            preg_match_all('/<input\b[^>]*>/i', $formHtml, $inputMatches);
            $hidden = [];
            $inputNames = [];
            foreach ($inputMatches[0] as $inputHtml) {
                $name = $this->attr($inputHtml, 'name');
                if ($name === '') {
                    continue;
                }
                $inputNames[] = $name;
                if (strtolower($this->attr($inputHtml, 'type')) === 'hidden') {
                    $hidden[$name] = $this->attr($inputHtml, 'value');
                }
            }
            $forms[] = [
                'action' => $this->absoluteUrl($this->attr($formHtml, 'action') ?: $baseUrl, $baseUrl),
                'method' => strtoupper($this->attr($formHtml, 'method') ?: 'POST'),
                'hidden' => $hidden,
                'inputNames' => $inputNames,
            ];
        }
        return $forms;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function extractCaptchaCandidates(string $html, string $baseUrl): array
    {
        preg_match_all('/<img\b[^>]*>/i', $html, $matches);
        $out = [];
        foreach ($matches[0] as $imgHtml) {
            $src = $this->attr($imgHtml, 'src');
            $haystack = strtolower($src . ' ' . $this->attr($imgHtml, 'alt') . ' ' . $this->attr($imgHtml, 'id') . ' ' . $this->attr($imgHtml, 'class'));
            if ($src === '' || !str_contains($haystack, 'captcha')) {
                continue;
            }
            $out[] = [
                'src' => str_starts_with($src, 'data:') ? '[data-uri-redacted]' : $this->absoluteUrl($src, $baseUrl),
                'isDataUri' => str_starts_with($src, 'data:'),
                'alt' => $this->attr($imgHtml, 'alt'),
            ];
        }
        return $out;
    }

    private function attr(string $html, string $name): string
    {
        if (!preg_match('/' . preg_quote($name, '/') . '\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))/i', $html, $match)) {
            return '';
        }
        return html_entity_decode($match[2] ?? $match[3] ?? $match[4] ?? '', ENT_QUOTES, 'UTF-8');
    }

    private function absoluteUrl(string $value, string $baseUrl): string
    {
        if (preg_match('/^https?:\/\//i', $value)) {
            return $value;
        }
        $base = parse_url($baseUrl);
        if (!$base || empty($base['scheme']) || empty($base['host'])) {
            return $value;
        }
        if (str_starts_with($value, '/')) {
            return $base['scheme'] . '://' . $base['host'] . $value;
        }
        $dir = rtrim(dirname($base['path'] ?? '/'), '/');
        return $base['scheme'] . '://' . $base['host'] . ($dir ? '/' . ltrim($dir, '/') : '') . '/' . ltrim($value, '/');
    }

    private function fieldNameFromSelector(string $selector, string $fallback): string
    {
        return preg_match('/\[name=["\']?([^"\']+)/i', $selector, $match) ? $match[1] : $fallback;
    }

    /**
     * @param array<int, string> $headers
     * @return array<string, string>
     */
    private function normalizeHeaders(array $headers): array
    {
        $out = [];
        foreach ($headers as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $out[strtolower(trim($name))] = trim($value);
        }
        return $out;
    }

    /**
     * @param array<int, string> $headers
     */
    private function statusFromHeaders(array $headers): int
    {
        foreach ($headers as $line) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $match)) {
                return (int) $match[1];
            }
        }
        return 0;
    }

    private function sanitizeText(string $text): string
    {
        $text = preg_replace('/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/', '[email]', $text) ?? $text;
        return preg_replace('/\b\d{12,20}\b/', '[digits]', $text) ?? $text;
    }
}
