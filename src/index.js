import fs from 'fs-extra';
import path from 'path';
import { readConfig } from './env.js';
import { claimJob, completeJob, downloadJobInput, failJob, heartbeat, logWorkerEvent, updateProgress } from './apiClient.js';
import { readInputRows } from './inputReader.js';
import { createLogger } from './logger.js';
import { ResultWriter, resultFromError } from './resultWriter.js';
import { SiksChecker } from './siksChecker.js';

const config = readConfig();
const logger = createLogger(config);

if (!config.workerApiKey) {
  throw new Error('WORKER_API_KEY wajib diisi.');
}

class ShutdownRequestedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShutdownRequestedError';
  }
}

class RowTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RowTimeoutError';
  }
}

await validateStartupConfig();

let state = { status: 'idle', currentJobId: null };
let stopRequested = false;
let wakeShutdown = null;
let retainedChecker = null;
const shutdownSignal = new Promise(resolve => {
  wakeShutdown = resolve;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopRequested = true;
    logger.warn(`[worker] menerima ${signal}; worker akan berhenti setelah titik aman.`);
    wakeShutdown?.();
  });
}

setInterval(() => {
  heartbeat(config, state).catch(error => {
    logger.warn(`[heartbeat] ${error.message}`);
  });
}, config.heartbeatIntervalMs).unref();

if (Number(config.outputCleanupIntervalMs || 0) > 0) {
  setInterval(() => {
    cleanupOldOutputs().catch(error => {
      logger.warn(`[cleanup] ${error.message}`);
    });
  }, config.outputCleanupIntervalMs).unref();
}

await heartbeat(config, state).catch(error => {
  logger.warn(`[heartbeat] belum tersambung: ${error.message}`);
});
await cleanupOldOutputs().catch(error => {
  logger.warn(`[cleanup] awal gagal: ${error.message}`);
});
logger.info(`[worker] ${config.workerName} siap mengambil job dari ${config.apiBaseUrl} (mode ${config.logLevel})`);
logger.info(`[worker] auth mode: ${config.siksAuthMode || 'puppeteer'}`);

let idleDelayMs = config.idlePollIntervalMs;
let jobsHandled = 0;
while (!stopRequested) {
  try {
    const claimed = await claimJob(config);
    if (!claimed.job) {
      state = { status: 'idle', currentJobId: null };
      if (config.runOnce) {
        logger.info('[worker] tidak ada job queued, RUN_ONCE selesai.');
        break;
      }
      logger.debug('[worker] antrian kosong; menunggu sebelum claim berikutnya.', { idle_delay_ms: idleDelayMs });
      await waitOrShutdown(idleDelayMs);
      idleDelayMs = nextIdleDelay(config, idleDelayMs);
      continue;
    }

    idleDelayMs = config.idlePollIntervalMs;
    state = { status: 'processing', currentJobId: Number(claimed.job.id) };
    await processJob(claimed.job);
    jobsHandled += 1;
    state = { status: 'idle', currentJobId: null };
    if (config.maxJobsPerRun > 0 && jobsHandled >= config.maxJobsPerRun) {
      logger.info(`[worker] MAX_JOBS_PER_RUN tercapai (${jobsHandled}), worker selesai.`);
      break;
    }
    if (config.runOnce) {
      logger.info('[worker] RUN_ONCE selesai setelah satu job.');
      break;
    }
  } catch (error) {
    logger.error('[loop] worker loop error', error);
    state = { status: 'idle', currentJobId: null };
    if (config.runOnce) {
      process.exitCode = 1;
      break;
    }
    await waitOrShutdown(config.loopErrorBackoffMs);
  }
}

state = { status: 'idle', currentJobId: null };
await closeRetainedChecker('shutdown');
await heartbeat(config, state).catch(error => {
  logger.warn(`[heartbeat] final gagal: ${error.message}`);
});
logger.info('[worker] berhenti dengan aman.');

async function processJob(job) {
  const jobDir = path.resolve('output', `job_${job.id}`);
  await fs.ensureDir(jobDir);
  logger.info(`[job ${job.id}] mulai: ${job.original_filename}`);

  const timeoutBudget = createTimeoutBudget(config, job, logger);

  try {
    await safeWorkerEvent(job, 'worker_started', 'Worker mulai memproses job.', {
      worker_name: config.workerName,
      auth_mode: config.siksAuthMode,
      keep_browser_open: config.keepBrowserOpen,
    });

    const inputPath = await downloadJobInput(config, job, jobDir);
    timeoutBudget.assertWithin('download input');

    const rows = await readInputRows(inputPath, job);
    timeoutBudget.assertWithin('baca input');

    let checker = null;
    const writer = new ResultWriter(jobDir, { inputRows: rows, job });
    const existingSummary = config.resumePartialResults ? await writer.existingSummary() : { rowCount: 0, errorCount: 0, statusErrorCount: 0, resultCounts: {} };
    let resumeRows = existingSummary.rowCount > 0 && existingSummary.rowCount <= rows.length ? existingSummary.rowCount : 0;
    if (config.recheckErrorRowsBeforeComplete && existingSummary.statusErrorCount > 0) {
      logger.warn(`[job ${job.id}] hasil partial memiliki ${existingSummary.statusErrorCount} row berstatus ERROR; worker mengulang job agar row error diperiksa lagi sebelum hasil dikirim.`);
      await safeWorkerEvent(job, 'worker_recheck_partial_errors', 'Hasil partial mengandung row error dan akan diperiksa ulang sebelum complete.', {
        partial_rows: existingSummary.rowCount,
        error_rows: existingSummary.statusErrorCount,
      });
      resumeRows = 0;
    }
    await writer.init({ append: resumeRows > 0 });

    let processed = resumeRows;
    const resultCounts = resumeRows > 0 ? { ...existingSummary.resultCounts } : {};
    let errorCount = resumeRows > 0 ? existingSummary.errorCount : 0;
    let consecutiveRowErrors = 0;
    let browserRestarts = 0;
    const syncProgress = createProgressSync(config, job, rows.length, logger);
    await syncProgress(processed, true);

    if (resumeRows > 0) {
      logger.info(`[job ${job.id}] resume partial result lokal dari ${resumeRows}/${rows.length} row.`);
      await safeWorkerEvent(job, 'worker_resume_partial', 'Worker melanjutkan hasil partial lokal.', {
        resume_rows: resumeRows,
        rows_total: rows.length,
      });
    }
    if (resumeRows >= rows.length) {
      const summary = createJobSummary(config, rows.length, processed, errorCount, resultCounts, timeoutBudget, browserRestarts, true);
      await fs.writeJson(path.join(jobDir, 'summary.json'), summary, { spaces: 2 });
      await safeWorkerEvent(job, 'worker_resend_result', 'Hasil partial lokal sudah lengkap, worker mengirim ulang ke API.', {
        rows_total: rows.length,
      });
      const packagePath = await writer.finalize();
      await completeJob(config, job, packagePath, summary);
      logger.info(`[job ${job.id}] hasil partial lokal sudah lengkap, dikirim ulang ke API.`, summary);
      return;
    }

    async function startChecker(reason, options = {}) {
      const checkerName = isDirectAuthMode(config.siksAuthMode) ? 'auth direct' : 'Puppeteer';
      const forceNew = Boolean(options.forceNew);
      if (forceNew && retainedChecker) {
        await retainedChecker.close();
        retainedChecker = null;
      }
      if (checker && checker !== retainedChecker) {
        await checker.close();
      }
      if (config.keepBrowserOpen && retainedChecker) {
        const reusable = await retainedChecker.prepareForJob(jobDir);
        if (reusable) {
          checker = retainedChecker;
          logger.info(`[job ${job.id}] ${checkerName} reuse dari sesi sebelumnya${reason ? ` (${reason})` : ''}.`);
          return;
        }

        logger.warn(`[job ${job.id}] sesi checker lama tidak sehat; worker membuka sesi baru.`);
        await retainedChecker.close().catch(error => {
          logger.debug(`[job ${job.id}] gagal menutup sesi lama`, { message: error.message });
        });
        retainedChecker = null;
      }
      checker = new SiksChecker(config, jobDir);
      await checker.init();
      if (config.keepBrowserOpen) {
        retainedChecker = checker;
      }
      logger.info(`[job ${job.id}] ${checkerName} siap${reason ? ` (${reason})` : ''}.`);
    }

    async function restartChecker(error, stage) {
      if (browserRestarts >= config.browserRestartAttempts) {
        throw error;
      }
      browserRestarts += 1;
      const checkerName = isDirectAuthMode(config.siksAuthMode) ? 'auth direct' : 'Puppeteer';
      logger.warn(`[job ${job.id}] ${checkerName} restart karena ${stage}: ${error.message} (${browserRestarts}/${config.browserRestartAttempts}).`);
      await startChecker('restart', { forceNew: true });
      await safeWorkerEvent(job, 'worker_browser_restart', 'Checker SIKS direstart oleh worker.', {
        auth_mode: config.siksAuthMode,
        stage,
        error_message: error.message,
        restart_count: browserRestarts,
        max_restarts: config.browserRestartAttempts,
      });
      timeoutBudget.assertWithin(`restart puppeteer ${stage}`);
    }

    async function checkEntryWithRecovery(entry, rowNumber) {
      const regularAttempts = Math.max(1, Number(config.rowRetryAttempts || 1));
      const errorRecheckAttempts = config.recheckErrorRowsBeforeComplete
        ? Math.max(1, Number(config.rowErrorRecheckAttempts || 1))
        : 0;
      const maxAttempts = regularAttempts + errorRecheckAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await withTimeout(
            checker.checkEntry(entry),
            config.rowTimeoutMs,
            new RowTimeoutError(`Row ${rowNumber} timeout setelah ${Math.round(Number(config.rowTimeoutMs || 0) / 1000)} detik.`)
          );
          if (isErrorResult(result)) {
            throw new Error(result.error || `Row ${rowNumber} menghasilkan status ERROR.`);
          }
          return result;
        } catch (error) {
          const recoverable = isBrowserRecoverableError(error);
          if (attempt >= maxAttempts) {
            throw error;
          }
          const phase = attempt >= regularAttempts ? 'recheck error final' : 'retry row';
          logger.warn(`[job ${job.id}] ${phase} ${rowNumber}: ${error.message} (${attempt + 1}/${maxAttempts}).`);
          if (recoverable) {
            await restartChecker(error, `row ${rowNumber} attempt ${attempt}`);
          } else {
            await sleep(Math.max(250, Number(config.rowErrorRecheckDelayMs || 1000)));
          }
        }
      }
      throw new Error(`Row ${rowNumber} gagal tanpa detail.`);
    }

    try {
      await startChecker('init');
      timeoutBudget.assertWithin('init checker');

      for (const entry of rows.slice(processed)) {
        if (stopRequested && config.requeueOnShutdown) {
          throw new ShutdownRequestedError('Worker diminta stop; job dikembalikan ke retry queue di batas row yang aman.');
        }
        timeoutBudget.assertWithin(`sebelum row ${processed + 1}`);
        try {
          const result = await checkEntryWithRecovery(entry, processed + 1);
          await writer.append(result);
          resultCounts[result.status || 'UNKNOWN'] = (resultCounts[result.status || 'UNKNOWN'] || 0) + 1;
          processed += 1;
          consecutiveRowErrors = 0;
          await syncProgress(processed, processed === rows.length);
          logger.progress(job, processed, rows.length, result.status, entry);
        } catch (error) {
          if (isBrowserRecoverableError(error)) {
            throw error;
          }
          const result = resultFromError(entry, error);
          await writer.append(result);
          resultCounts[result.status || 'ERROR'] = (resultCounts[result.status || 'ERROR'] || 0) + 1;
          errorCount += 1;
          consecutiveRowErrors += 1;
          processed += 1;
          await syncProgress(processed, processed === rows.length);
          logger.debug(`[job ${job.id}] row error`, {
            row: processed,
            nik: entry.nik,
            message: error.message,
          });
          logger.progress(job, processed, rows.length, result.status, entry);
          if (config.maxConsecutiveRowErrors > 0 && consecutiveRowErrors >= config.maxConsecutiveRowErrors) {
            throw new Error(`${consecutiveRowErrors} row beruntun error; job dikembalikan ke retry queue agar browser/session bisa dimulai ulang bersih.`);
          }
        }
        timeoutBudget.assertWithin(`setelah row ${processed}`);
      }
    } finally {
      if (checker && (!config.keepBrowserOpen || checker !== retainedChecker)) {
        await checker.close();
      } else if (checker && config.keepBrowserOpen) {
        logger.debug(`[job ${job.id}] checker tetap dipakai untuk job berikutnya.`);
      }
    }

    const summary = createJobSummary(config, rows.length, processed, errorCount, resultCounts, timeoutBudget, browserRestarts, resumeRows > 0);
    await fs.writeJson(path.join(jobDir, 'summary.json'), summary, { spaces: 2 });
    const packagePath = await writer.finalize();
    await completeJob(config, job, packagePath, summary);
    logger.info(`[job ${job.id}] selesai, hasil dikirim ke API.`, summary);
  } catch (error) {
    if (error instanceof ShutdownRequestedError) {
      logger.warn(`[job ${job.id}] dihentikan aman: ${error.message}`);
      await safeWorkerEvent(job, 'worker_shutdown_requeue', 'Worker diminta stop dan mengembalikan job ke retry queue.', {
        reason: error.message,
      });
    } else {
      logger.error(`[job ${job.id}] gagal`, error);
    }
    await failJob(config, job, error).catch(failError => {
      logger.error(`[job ${job.id}] gagal menandai failed`, failError);
    });
  }
}

async function closeRetainedChecker(reason) {
  if (!retainedChecker) {
    return;
  }
  if (config.leaveBrowserOpenOnExit && !isDirectAuthMode(config.siksAuthMode)) {
    logger.info(`[worker] browser dibiarkan terbuka saat ${reason}.`);
    return;
  }
  const checker = retainedChecker;
  retainedChecker = null;
  await checker.close().catch(error => {
    logger.warn(`[worker] gagal menutup browser saat ${reason}: ${error.message}`);
  });
}

async function validateStartupConfig() {
  const issues = [];
  const directAuth = isDirectAuthMode(config.siksAuthMode);
  if (!config.siksUsername || !config.siksPassword) {
    issues.push('SIKS_USERNAME dan SIKS_PASSWORD wajib diisi.');
  }
  if (!config.geminiApiKeys?.length && !(directAuth && config.siksDirectCaptchaText)) {
    issues.push('GEMINI_API_KEY atau GEMINI_API_KEYS wajib diisi.');
  }
  if (!directAuth && !config.chromeExecutablePath) {
    issues.push('CHROME_EXECUTABLE_PATH wajib diisi untuk puppeteer-core.');
  } else if (!directAuth && !await fs.pathExists(config.chromeExecutablePath)) {
    issues.push(`CHROME_EXECUTABLE_PATH tidak ditemukan: ${config.chromeExecutablePath}`);
  }
  if (issues.length) {
    throw new Error(`Config worker belum lengkap: ${issues.join(' ')}`);
  }
}

async function cleanupOldOutputs() {
  const retentionDays = Math.max(0, Number(config.outputRetentionDays || 0));
  if (retentionDays <= 0) {
    return;
  }
  const outputDir = path.resolve('output');
  if (!await fs.pathExists(outputDir)) {
    return;
  }
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (const name of await fs.readdir(outputDir)) {
    if (!/^job_\d+$/.test(name)) {
      continue;
    }
    const fullPath = path.join(outputDir, name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat?.isDirectory() || stat.mtimeMs >= cutoff) {
      continue;
    }
    if (state.currentJobId && name === `job_${state.currentJobId}`) {
      continue;
    }
    await fs.remove(fullPath);
    deleted += 1;
  }
  if (deleted > 0) {
    logger.info(`[cleanup] ${deleted} folder output lama dihapus.`);
  }
}

async function safeWorkerEvent(job, eventType, message, payload = null) {
  try {
    await logWorkerEvent(config, job, eventType, message, payload);
  } catch (error) {
    logger.debug(`[job ${job.id}] gagal mencatat event worker`, { event_type: eventType, message: error.message });
  }
}

function createProgressSync(config, job, rowsTotal, logger) {
  const updateEvery = Math.max(1, Number(config.progressUpdateEvery || 1));
  const updateIntervalMs = Math.max(0, Number(config.progressUpdateIntervalMs || 0));
  let lastRows = -1;
  let lastAt = 0;

  return async function syncProgress(rowsProcessed, force = false) {
    const now = Date.now();
    const rowsDelta = rowsProcessed - lastRows;
    const intervalPassed = updateIntervalMs > 0 && now - lastAt >= updateIntervalMs;
    if (!force && rowsProcessed < rowsTotal && lastRows >= 0 && rowsDelta < updateEvery && !intervalPassed) {
      return;
    }

    try {
      await updateProgress(config, job, { rows_total: rowsTotal, rows_processed: rowsProcessed });
      lastRows = rowsProcessed;
      lastAt = now;
    } catch (error) {
      logger.debug(`[job ${job.id}] gagal update progress`, { message: error.message });
    }
  };
}

function createJobSummary(config, rowsTotal, rowsProcessed, rowsError, resultCounts, timeoutBudget, browserRestarts, resumed) {
  return {
    rows_total: rowsTotal,
    rows_processed: rowsProcessed,
    rows_error: rowsError,
    result_counts: resultCounts,
    completed_at: new Date().toISOString(),
    worker_name: config.workerName,
    auth_mode: config.siksAuthMode || 'puppeteer',
    runtime_seconds: timeoutBudget.elapsedSeconds,
    timeout_extensions: timeoutBudget.extensions,
    browser_restarts: isDirectAuthMode(config.siksAuthMode) ? 0 : browserRestarts,
    checker_restarts: browserRestarts,
    row_error_recheck_attempts: config.recheckErrorRowsBeforeComplete ? Number(config.rowErrorRecheckAttempts || 0) : 0,
    resumed_partial_results: Boolean(resumed),
  };
}

function isErrorResult(result) {
  return String(result?.status || '').trim().toUpperCase() === 'ERROR';
}

function createTimeoutBudget(config, job, logger) {
  const startedAt = Date.now();
  const softLimitMs = Math.max(0, Number(config.jobTimeoutMs || 0));
  const graceMs = Math.max(0, Number(config.jobTimeoutGraceMs || softLimitMs));
  const maxExtensions = Math.max(0, Number(config.maxTimeoutExtensions || 0));
  let deadline = softLimitMs > 0 ? startedAt + softLimitMs : null;
  let extensions = 0;

  return {
    get extensions() {
      return extensions;
    },
    get elapsedSeconds() {
      return Math.round((Date.now() - startedAt) / 1000);
    },
    assertWithin(stage) {
      if (!deadline || Date.now() <= deadline) {
        return;
      }

      if (graceMs > 0 && extensions < maxExtensions) {
        extensions += 1;
        deadline = Date.now() + graceMs;
        logger.warn(`[job ${job.id}] timeout lembut lewat di ${stage}; lanjut menunggu ${Math.round(graceMs / 1000)} detik lagi (${extensions}/${maxExtensions}).`);
        return;
      }

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const totalLimit = Math.round((softLimitMs + graceMs * maxExtensions) / 1000);
      throw new Error(`Job timeout setelah ${elapsed} detik (limit total ${totalLimit} detik, extension terpakai ${extensions}).`);
    },
  };
}

function isBrowserRecoverableError(error) {
  if (error instanceof RowTimeoutError) {
    return true;
  }
  if (error?.code === 'SIKS_SESSION_EXPIRED') {
    return true;
  }
  const message = `${error?.name || ''} ${error?.message || ''} ${error?.stack || ''}`.toLowerCase();
  return [
    'target closed',
    'session closed',
    'browser has disconnected',
    'protocol error',
    'execution context was destroyed',
    'navigation failed because browser has disconnected',
    'page crashed',
    'pemulihan sesi siks gagal',
  ].some(token => message.includes(token));
}

function isDirectAuthMode(value) {
  return ['direct', 'http', 'api', 'login-direct'].includes(String(value || '').trim().toLowerCase());
}

function withTimeout(promise, timeoutMs, timeoutError) {
  const ms = Math.max(0, Number(timeoutMs || 0));
  if (!ms) {
    return promise;
  }
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function nextIdleDelay(config, currentDelay) {
  const base = Math.max(1000, Number(config.idlePollIntervalMs || config.pollIntervalMs || 10000));
  const max = Math.max(base, Number(config.idlePollMaxIntervalMs || base));
  const factor = Math.max(1, Number(config.idlePollBackoffFactor || 1));
  return Math.min(max, Math.max(base, Math.round(Number(currentDelay || base) * factor)));
}

async function waitOrShutdown(ms) {
  if (stopRequested) {
    return;
  }
  await Promise.race([sleep(ms), shutdownSignal]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
