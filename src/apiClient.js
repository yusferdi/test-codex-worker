import fs from 'fs-extra';
import path from 'path';
import { requestJson, requestResponse } from './httpClient.js';
import { workerApiUrl, workerAuthHeaders } from './workerApiEndpoints.js';

export async function postJson(config, endpoint, payload, options = {}) {
  const requestConfig = {
    ...config,
    apiRequestTimeoutMs: options.timeoutMs ?? config.apiRequestTimeoutMs,
    apiRetryAttempts: options.retryAttempts ?? config.apiRetryAttempts,
  };
  return requestJson(workerApiUrl(config, endpoint), {
    label: endpoint,
    method: 'POST',
    headers: workerAuthHeaders(config, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(payload),
  }, requestConfig);
}

export async function heartbeat(config, state) {
  return postJson(config, 'heartbeat', {
    worker_name: config.workerName,
    status: state.status,
    current_job_id: state.currentJobId || null,
    version: '1.0.0',
    host_info: process.platform,
  }, {
    retryAttempts: 1,
    timeoutMs: Math.min(Number(config.apiRequestTimeoutMs || 10000), 10000),
  });
}

export async function claimJob(config) {
  return postJson(config, 'claim', {
    worker_name: config.workerName,
  });
}

export async function downloadJobInput(config, job, targetDir) {
  await fs.ensureDir(targetDir);
  const ext = path.extname(job.original_filename || '') || '.bin';
  const target = path.join(targetDir, safeWorkerFilename(job.original_filename || `input_${job.id}${ext}`));
  const response = await requestResponse(job.input_download_url, {
    label: `download input job ${job.id}`,
    headers: workerAuthHeaders(config),
  }, config, {
    requireOk: true,
    errorMessage: response => `Download input gagal: HTTP ${response.status}`,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, bytes);
  return target;
}

function safeWorkerFilename(filename) {
  const cleaned = String(filename || 'input')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 160);
  if (!cleaned) return 'input';
  const extension = path.extname(cleaned);
  const basename = path.basename(cleaned, extension);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)) {
    return `file_${cleaned}`;
  }
  return cleaned;
}

export async function completeJob(config, job, resultPath, summary) {
  const bytes = await fs.readFile(resultPath);
  const contentType = path.extname(resultPath).toLowerCase() === '.zip' ? 'application/zip' : 'text/csv';
  const payload = {
    job_id: job.id,
    worker_name: config.workerName,
    rows_total: summary.rows_total || 0,
    rows_processed: summary.rows_processed || 0,
    summary_json: JSON.stringify(summary),
    email: job.email || '',
    original_filename: job.original_filename || '',
    result_path: resultPath,
  };
  try {
    const form = new FormData();
    form.append('job_id', String(payload.job_id));
    form.append('worker_name', payload.worker_name);
    form.append('rows_total', String(payload.rows_total));
    form.append('rows_processed', String(payload.rows_processed));
    form.append('summary_json', payload.summary_json);
    form.append('email', payload.email);
    form.append('original_filename', payload.original_filename);
    form.append('result_file', new Blob([bytes], { type: contentType }), path.basename(resultPath));

    const result = await requestJson(workerApiUrl(config, 'complete'), {
      label: `complete job ${job.id}`,
      method: 'POST',
      headers: workerAuthHeaders(config),
      body: form,
    }, config);
    if (result?.fallback_storage) {
      await recordApiFallback(config, job, 'complete_fallback_ack', payload, new Error('API menyimpan hasil ke fallback storage.'));
    }
    return result;
  } catch (error) {
    await recordApiFallback(config, job, 'complete_failed', payload, error);
    throw error;
  }
}

export async function updateProgress(config, job, summary) {
  const payload = {
    job_id: job.id,
    worker_name: config.workerName,
    status: 'processing',
    rows_total: summary.rows_total || 0,
    rows_processed: summary.rows_processed || 0,
    email: job.email || '',
    original_filename: job.original_filename || '',
  };
  try {
    const result = await postJson(config, 'progress', payload);
    if (result?.fallback_storage) {
      await recordApiFallback(config, job, 'progress_fallback_ack', payload, new Error('API menyimpan progress ke fallback storage.'));
    }
    return result;
  } catch (error) {
    await recordApiFallback(config, job, 'progress_failed', payload, error);
    throw error;
  }
}

export async function logWorkerEvent(config, job, eventType, message, payload = null) {
  const eventPayload = {
    job_id: job.id,
    worker_name: config.workerName,
    event_type: eventType,
    message,
    payload,
  };
  try {
    const result = await postJson(config, 'event', eventPayload, {
      retryAttempts: 1,
      timeoutMs: Math.min(Number(config.apiRequestTimeoutMs || 10000), 10000),
    });
    if (result?.fallback_storage) {
      await recordApiFallback(config, job, 'event_fallback_ack', eventPayload, new Error('API menyimpan event ke fallback storage.'));
    }
    return result;
  } catch (error) {
    await recordApiFallback(config, job, 'event_failed', eventPayload, error);
    throw error;
  }
}

export async function failJob(config, job, error) {
  const requeueWithoutPenalty = error?.name === 'ShutdownRequestedError' || Boolean(error?.requeueWithoutPenalty);
  const payload = {
    job_id: job.id,
    worker_name: config.workerName,
    error_message: error?.stack || error?.message || String(error),
    failure_kind: error?.name || '',
    requeue_without_penalty: requeueWithoutPenalty,
    email: job.email || '',
    original_filename: job.original_filename || '',
  };
  try {
    const result = await postJson(config, 'fail', payload);
    if (result?.fallback_storage) {
      await recordApiFallback(config, job, 'fail_fallback_ack', payload, new Error('API menyimpan failure ke fallback storage.'));
    }
    return result;
  } catch (apiError) {
    await recordApiFallback(config, job, 'fail_failed', payload, apiError);
    throw apiError;
  }
}

export async function recordApiFallback(config, job, kind, payload, error) {
  try {
    const jobId = Number(job?.id || payload?.job_id || 0);
    if (!jobId) {
      return;
    }
    const dir = path.resolve(config.apiFallbackDir || './output/api-fallback', `job_${jobId}`);
    await fs.ensureDir(dir);
    const row = {
      kind,
      job_id: jobId,
      worker_name: config.workerName,
      payload,
      error: error?.message || String(error || ''),
      created_at: new Date().toISOString(),
    };
    await fs.appendFile(path.join(dir, 'api_fallback.jsonl'), `${JSON.stringify(row)}\n`);
    await fs.writeJson(path.join(dir, 'latest.json'), row, { spaces: 2 });
  } catch {
    // Local fallback must not interrupt worker progress.
  }
}
