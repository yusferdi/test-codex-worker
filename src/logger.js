export function createLogger(config) {
  const verbose = config.logLevel === 'verbose';
  const progressEvery = Math.max(1, Number(config.progressLogEvery || 25));

  function write(level, message, meta = null) {
    const prefix = `${new Date().toISOString()} [${level}]`;
    const suffix = verbose && meta ? ` ${safeJson(meta)}` : '';
    const line = `${prefix} ${message}${suffix}`;
    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    verbose,
    info(message, meta = null) {
      write('info', message, meta);
    },
    warn(message, meta = null) {
      write('warn', message, meta);
    },
    error(message, error = null) {
      if (!error) {
        write('error', message);
        return;
      }
      const detail = verbose ? (error.stack || error.message || String(error)) : (error.message || String(error));
      write('error', `${message}: ${detail}`);
    },
    debug(message, meta = null) {
      if (verbose) {
        write('debug', message, meta);
      }
    },
    progress(job, processed, total, status = '', entry = null) {
      if (verbose) {
        write('info', `[job ${job.id}] ${processed}/${total} NIK ${entry?.nik || '-'}: ${status || '-'}`);
        return;
      }
      if (processed === 1 || processed === total || processed % progressEvery === 0) {
        write('info', `[job ${job.id}] progress ${processed}/${total}`);
      }
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
