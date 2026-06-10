export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function fetchWithTimeout(url, options = {}, settings = {}) {
  const timeoutMs = Math.max(0, Number(settings.timeoutMs || 0));
  if (!timeoutMs) {
    return fetch(url, options);
  }

  const { signal: upstreamSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal = mergeSignals(controller.signal, upstreamSignal);

  try {
    return await fetch(url, { ...fetchOptions, signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError(settings.timeoutMessage || `Request timeout setelah ${Math.round(timeoutMs / 1000)} detik.`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(timeoutSignal, upstreamSignal) {
  if (!upstreamSignal) {
    return timeoutSignal;
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, upstreamSignal]);
  }
  return timeoutSignal;
}

export async function requestJson(url, options = {}, config = {}, parseOptions = {}) {
  const { label, ...fetchOptions } = options;
  return withRetry(config, label || url, async signal => {
    const response = await fetch(url, { ...fetchOptions, signal });
    return parseJsonResponse(response, parseOptions);
  });
}

export async function requestResponse(url, options = {}, config = {}, responseOptions = {}) {
  const { label, ...fetchOptions } = options;
  return withRetry(config, label || url, async signal => {
    const response = await fetch(url, { ...fetchOptions, signal });
    if (responseOptions.requireOk && !response.ok) {
      const message = typeof responseOptions.errorMessage === 'function'
        ? responseOptions.errorMessage(response)
        : (responseOptions.errorMessage || `HTTP ${response.status}`);
      throw new ApiError(message, response.status);
    }
    return response;
  });
}

export async function parseJsonResponse(response, options = {}) {
  const requireOk = options.requireOk ?? true;
  const text = await response.text().catch(() => '');
  const data = parseJsonOrNull(text);
  if (!data) {
    if (!response.ok) {
      throw new ApiError(`HTTP ${response.status}`, response.status);
    }
    throw new ApiError(options.invalidJsonMessage || 'Response bukan JSON valid.', response.status);
  }
  if (!response.ok || (requireOk && !data?.ok)) {
    const message = data?.error || data?.message || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data;
}

export async function withRetry(config, label, action) {
  const attempts = Math.max(1, Number(config.apiRetryAttempts ?? config.retryAttempts ?? 1));
  const timeoutMs = Math.max(0, Number(config.apiRequestTimeoutMs ?? config.timeoutMs ?? 0));
  const delayMs = Math.max(0, Number(config.apiRetryDelayMs ?? config.retryDelayMs ?? 0));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    timer?.unref?.();

    try {
      return await action(controller.signal);
    } catch (error) {
      lastError = normalizeAbortError(error, timeoutMs);
      if (attempt >= attempts || !isRetryable(lastError)) {
        throw lastError;
      }
      if (config.logLevel === 'verbose') {
        console.warn(`[api retry] ${label} gagal attempt ${attempt}/${attempts}: ${lastError.message}`);
      }
      await sleep(delayMs * attempt);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  throw lastError || new Error(`${label} gagal tanpa detail.`);
}

function normalizeAbortError(error, timeoutMs) {
  if (error?.name === 'AbortError') {
    return new ApiError(`Request timeout setelah ${Math.round(timeoutMs / 1000)} detik.`, 0);
  }
  return error;
}

function isRetryable(error) {
  const status = Number(error?.status || 0);
  if (status === 0) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500;
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
