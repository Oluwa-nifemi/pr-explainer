const secrets = new Set();

export function registerSecrets(...values) {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    secrets.add(value);
    secrets.add(encodeURIComponent(value));
    secrets.add(JSON.stringify(value).slice(1, -1));
  }
}

export function redact(value) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.href;
      } catch {
        return '[REDACTED URL]';
      }
    });
}

export function errorDetails(error) {
  const codes = [];
  const seen = new Set();
  const visit = (err) => {
    if (!err || seen.has(err) || seen.size >= 12) return;
    seen.add(err);
    if (typeof err.code === 'string' && /^[A-Z0-9_]{1,60}$/i.test(err.code)) codes.push(err.code);
    visit(err.cause);
    if (Array.isArray(err.errors)) err.errors.forEach(visit);
  };
  visit(error);
  return JSON.stringify({
    name: /^[A-Za-z]{1,50}$/.test(error?.name) ? error.name : 'Error',
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    codes: [...new Set(codes)],
  });
}
