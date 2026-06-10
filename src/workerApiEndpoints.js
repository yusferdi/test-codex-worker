export const WORKER_API_ENDPOINTS = Object.freeze({
  health: 'health.php',
  ping: 'worker_ping.php',
  heartbeat: 'worker_heartbeat.php',
  claim: 'worker_claim.php',
  download: 'worker_download.php',
  complete: 'worker_complete.php',
  progress: 'worker_progress.php',
  event: 'worker_event.php',
  fail: 'worker_fail.php',
});

export function workerApiUrl(config, endpoint) {
  const path = WORKER_API_ENDPOINTS[endpoint] || endpoint;
  return `${config.apiBaseUrl}/${String(path).replace(/^\/+/, '')}`;
}

export function workerAuthHeaders(config, extra = {}) {
  return {
    ...extra,
    'X-Worker-Key': config.workerApiKey,
  };
}
