import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.github.com';
const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function networkCodes(error, seen = new Set()) {
  if (!error || seen.has(error) || seen.size >= 12) return [];
  seen.add(error);
  return [
    ...(typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? [error.code] : []),
    ...networkCodes(error.cause, seen),
    ...(Array.isArray(error.errors) ? error.errors.flatMap((cause) => networkCodes(cause, seen)) : []),
  ];
}

export async function fetchGithub(path, init, readOnly) {
  const started = Date.now();
  const context = 'method=' + init.method + ' path=' + path.split('?')[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    let text;
    let readError;
    try {
      res = await fetch(API + path, { ...init, signal: readOnly ? AbortSignal.timeout(15000) : init.signal });
      text = await res.text();
    } catch (err) {
      readError = err;
      const codes = [...new Set(networkCodes(err))];
      const transient = err.name === 'TimeoutError' || codes.some((code) => NETWORK_CODES.has(code));
      const name = /^[A-Za-z]{1,50}$/.test(err.name) ? err.name : 'Error';
      console.error('github connection failed ' + context + ' attempt=' + (attempt + 1) + ' durationMs=' + (Date.now() - started) + ' ' + JSON.stringify({ name, codes }));
      if (!readOnly || attempt === 2 || !transient || (res && !res.ok && !RETRY_STATUSES.has(res.status))) throw err;
    }
    let waitMs = 400 * (attempt + 1) + Math.floor(Math.random() * 200);
    if (text !== undefined) {
      if (res.ok) {
        if (attempt) console.info('github request recovered ' + context + ' attempt=' + (attempt + 1) + ' durationMs=' + (Date.now() - started));
        return { res, text };
      }
      console.warn('github request failed ' + context + ' attempt=' + (attempt + 1) + ' status=' + res.status + ' durationMs=' + (Date.now() - started) + ' requestId=' + (res.headers.get('x-github-request-id') || 'unknown'));
      if (!readOnly || attempt === 2 || !RETRY_STATUSES.has(res.status)) return { res, text };
    }
    const retryAfter = res?.headers.get('retry-after');
    if (retryAfter) {
      const requestedMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      if (!Number.isFinite(requestedMs) || requestedMs > 5000) {
        if (readError) throw readError;
        return { res, text };
      }
      waitMs = Math.max(waitMs, requestedMs);
    }
    console.warn('github request retry ' + context + ' nextAttempt=' + (attempt + 2) + ' delayMs=' + waitMs);
    await delay(waitMs);
  }
}
