import { decodeSiksAuthResponse, siksAuthFormData } from './siksAuthCrypto.js';
import { fetchWithTimeout } from './httpClient.js';

const DEFAULT_AUTH_BASE = 'https://api.kemensos.go.id';

export class SiksSpaAuthClient {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.baseUrl = trimSlash(options.baseUrl || config.siksAuthApiBaseUrl || config.siksApiBaseUrl || DEFAULT_AUTH_BASE);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || config.siksActionTimeoutMs || 15000));
    this.token = options.token || '';
    this.endpoints = {
      login: options.loginEndpoint || config.siksAuthLoginEndpoint || '/siks/auth/v1/login',
      captcha: options.captchaEndpoint || config.siksAuthCaptchaEndpoint || '/siks/auth/v1/get-captcha',
      matchingOtp: options.matchingOtpEndpoint || config.siksAuthMatchingOtpEndpoint || '/siks/auth/v1/matching-otp',
      resendOtp: options.resendOtpEndpoint || config.siksAuthResendOtpEndpoint || '/siks/auth/v1/resend-otp',
      profile: options.profileEndpoint || config.siksAuthProfileEndpoint || '/siks/auth/v1/get-profile',
    };
    this.usernameField = options.usernameField || config.siksHttpLoginUsernameField || process.env.SIKS_HTTP_LOGIN_USERNAME_FIELD || 'email';
  }

  async getCaptcha() {
    return this.requestAuth('GET', this.endpoints.captcha);
  }

  async login({ username, password, captcha, extra = {} } = {}) {
    const payload = {
      [this.usernameField]: username || this.config.siksUsername || '',
      password: password || this.config.siksPassword || '',
      captcha: captcha || '',
      ...extra,
    };
    const data = await this.requestAuth('POST', this.endpoints.login, payload);
    this.token = extractToken(data) || this.token;
    return { data, authorization: this.token };
  }

  async matchingOtp({ otp, email, extra = {} } = {}) {
    const payload = {
      email: email || this.config.siksUsername || '',
      otp: otp || '',
      type: 'sendotp',
      ...extra,
    };
    const data = await this.requestAuth('POST', this.endpoints.matchingOtp, payload);
    this.token = extractToken(data) || this.token;
    return { data, authorization: this.token };
  }

  async resendOtp({ email, extra = {} } = {}) {
    const payload = {
      email: email || this.config.siksUsername || '',
      type: 'resendotp',
      ...extra,
    };
    const data = await this.requestAuth('POST', this.endpoints.resendOtp, payload);
    this.token = extractToken(data) || this.token;
    return { data, authorization: this.token };
  }

  async getProfile() {
    return this.requestAuth('GET', this.endpoints.profile, null, { authorization: this.token });
  }

  async requestAuth(method, endpoint, payload = null, extraHeaders = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}/${String(endpoint).replace(/^\/+/, '')}`;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      origin: this.config.siksBaseUrl || 'https://siks.kemensos.go.id',
      referer: this.config.siksLoginUrl || 'https://siks.kemensos.go.id/login',
      ...extraHeaders,
    };
    if (this.token && !headers.authorization) {
      headers.authorization = this.token;
    }
    const options = {
      method,
      headers,
    };
    if (payload && method !== 'GET') {
      options.body = siksAuthFormData(payload, this.config.dtsenAppKey);
    }

    const response = await fetchWithTimeout(url, options, {
      timeoutMs: this.timeoutMs,
      timeoutMessage: `SIKS auth API timeout setelah ${Math.round(this.timeoutMs / 1000)} detik.`,
    });
    const rawText = await response.text();
    const decoded = decodeSiksAuthResponse(rawText, this.config.dtsenAppKey);
    if (!response.ok) {
      throw new Error(authErrorMessage(decoded, response.status));
    }
    return decoded;
  }
}

export function extractToken(data) {
  const candidates = [
    data?.data?.data?.access_token,
    data?.data?.data?.data,
    data?.data?.access_token,
    data?.access_token,
    data?.token,
    data?.data,
  ];
  return candidates.map(value => String(value || '').trim()).find(value => value.startsWith('Bearer ') || value.length > 40) || '';
}

function authErrorMessage(data, status) {
  return data?.message || data?.data?.message || data?.error || `SIKS auth API HTTP ${status}`;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
