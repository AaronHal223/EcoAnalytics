// Shared network helper. Every outside data source goes through here so
// timeouts and errors behave the same, and tests can swap `fetch`.

export class SourceUnavailable extends Error {}

const TIMEOUT_MS = 15000;

/** Set `globalThis.ECO_OFFLINE = true` (or add ?offline=1 to the URL) to skip all calls. */
export function offline() {
  if (globalThis.ECO_OFFLINE) return true;
  try { return new URLSearchParams(globalThis.location?.search || "").get("offline") === "1"; }
  catch { return false; }
}

async function request(url, init = {}, retries = 1) {
  if (offline()) throw new SourceUnavailable("offline mode");
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SourceUnavailable(`${url.split("?")[0]}: ${last?.message || last}`);
}

export function getJSON(url, params) {
  let full = url;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const one of [].concat(v)) qs.append(k, one);
    }
    full += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  return request(full);
}

/** Form-encoded POST: a "simple" CORS request, so no preflight is needed. */
export function postForm(url, fields) {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}
