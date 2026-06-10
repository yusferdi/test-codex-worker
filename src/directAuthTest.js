import path from 'path';
import { readConfig } from './env.js';
import { loginDirectSiks } from './siksDirectAuth.js';

process.env.SIKS_DIRECT_DEBUG_AUTH ??= '1';

const config = {
  ...readConfig(),
  siksAuthMode: 'direct',
};

try {
  const result = await loginDirectSiks(config, {
    jobDir: path.resolve('output', 'direct-auth-test'),
    reason: 'manual direct login test',
  });
  console.log(JSON.stringify({
    ok: true,
    source: result.source,
    method: result.method,
    loggedInAt: result.loggedInAt,
    hasAuthorization: Boolean(result.authorization),
    authorizationPreview: maskToken(result.authorization),
    profileWarning: result.profile?.warning || '',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    stage: error.stage || '',
  }, null, 2));
  process.exitCode = 1;
}

function maskToken(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= 16) {
    return '[present]';
  }
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}
