const STORAGE_KEY = "prx-diagnostics-v1";
const LIMIT = 200;
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
let entries = [];

function safeUrl(value) {
  try {
    const url = new URL(value, location.href);
    if (!["http:", "https:"].includes(url.protocol)) return url.protocol;
    return (url.origin + url.pathname).replace(/(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 500);
  } catch {
    return "unknown";
  }
}

function clean(entry) {
  return {
    at: Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString() : new Date().toISOString(),
    event: String(entry.event || "error").replace(/[^a-z_]/g, "").slice(0, 50),
    ...(entry.url ? { url: safeUrl(entry.url) } : {}),
    ...(Number.isInteger(entry.status) ? { status: entry.status } : {}),
    ...(Number.isFinite(entry.durationMs) ? { durationMs: Math.max(0, Math.round(entry.durationMs)) } : {}),
    ...(entry.name ? { name: /^[A-Za-z]{1,50}$/.test(entry.name) ? entry.name : "Error" } : {}),
    ...(Number.isInteger(entry.line) ? { line: entry.line } : {}),
  };
}

try {
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
  if (Array.isArray(saved)) entries = saved.slice(-LIMIT).filter((entry) => entry && Date.now() - Date.parse(entry.at) < MAX_AGE).map(clean);
} catch {}

export function recordDiagnostic(event, fields = {}) {
  entries.push(clean({ ...fields, event, at: new Date().toISOString() }));
  entries = entries.filter((entry) => Date.now() - Date.parse(entry.at) < MAX_AGE).slice(-LIMIT);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

export async function diagnosticFetch(url, options) {
  const started = Date.now();
  try {
    const response = await fetch(url, options);
    if (!response.ok) recordDiagnostic("request_failed", { url, status: response.status, durationMs: Date.now() - started });
    return response;
  } catch (error) {
    if (error.name !== "AbortError") recordDiagnostic("connection_failed", { url, name: error.name, durationMs: Date.now() - started });
    throw error;
  }
}

window.addEventListener("error", (event) => {
  const resource = event.target?.src || event.target?.href;
  recordDiagnostic(resource ? "resource_load_failed" : "uncaught_error", {
    url: resource || event.filename,
    line: event.lineno,
    name: event.error?.name,
  });
}, true);
window.addEventListener("unhandledrejection", (event) => recordDiagnostic("unhandled_rejection", { name: event.reason?.name }));
window.addEventListener("offline", () => recordDiagnostic("browser_offline"));
window.addEventListener("online", () => recordDiagnostic("browser_online"));

export async function downloadDiagnostics(api) {
  let service = null;
  let serviceUnavailable = false;
  try {
    const response = await diagnosticFetch(api + "/api/diagnostics", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Diagnostics unavailable");
    service = await response.json();
    if (!Array.isArray(service?.logs?.files)) throw new Error("Invalid diagnostics");
  } catch {
    service = null;
    serviceUnavailable = true;
    recordDiagnostic("service_export_failed");
  }
  recordDiagnostic("logs_collected");
  const report = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    warning: "May contain repository names, file paths and existing pipeline output. Review before sharing.",
    browser: { userAgent: navigator.userAgent, online: navigator.onLine, page: safeUrl(location.href), events: entries },
    serviceUnavailable,
    service,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pr-explainer-logs-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { serviceUnavailable, incomplete: !!service?.logs?.errors?.length, truncated: !!service?.logs?.truncated };
}
