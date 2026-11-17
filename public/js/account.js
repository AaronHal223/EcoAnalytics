// Free account: saves everything the app keeps on this phone to the EcoAnalytics
// server so it follows you to any phone or computer.
//
//  * The server is a small Neon function (server/api) with a Postgres table per user.
//  * Sign-in uses a random token kept on this device (no cookies), so it works the
//    same on iPhone, Android and computers.
//  * There is no email to verify. Signing up shows a recovery code once; it is the
//    only way to reset a forgotten password, so the page asks people to keep it.
//  * Only the user's own data is sent (the same keys as the backup file), never the
//    cached soil and weather lookups, which are re-fetched anyway.

import { isUserKey } from "./share.js";

export const API = "https://br-silent-scene-bdsrlorq-api.compute.c-8.us-east-2.aws.neon.tech";
export const AUTH_KEY = "eco-auth";          // {token, email}: not an "eco:" key, so never synced or backed up
export const SYNC_KEY = "eco-sync";          // {server: ISO time of the copy we last had, dirty: bool}
const TIMEOUT_MS = 20000;

export const ERRORS = {
  email: "That doesn't look like an email address.",
  password: "Use a password of at least 8 characters.",
  exists: "There's already an account with that email. Sign in instead.",
  wrong: "That email and password don't match.",
  slow_down: "Too many tries. Wait 15 minutes and try again.",
  signed_out: "You've been signed out. Sign in again.",
  too_big: "Your saved data is too big to sync (over 400 KB).",
  assistant_off: "The garden assistant isn't switched on yet.",
  consent: "Tick the box to agree before using the assistant.",
  messages: "Type a question first (up to 2,000 characters).",
  daily_limit: "That's today's 20 assistant questions. More tomorrow.",
  busy: "The assistant is busy right now. Try again in a minute.",
  ai_failed: "The assistant couldn't answer just now. Try again.",
  offline: "Can't reach the EcoAnalytics server. Check your connection.",
  server: "Something went wrong on the server. Try again.",
};
export const errorText = code => ERRORS[code] || ERRORS.server;

/** Calls the API. Resolves to the JSON body; rejects with an Error whose .code is one of ERRORS. */
export async function call(path, body, { token, fetchFn = globalThis.fetch, base = API } = {}) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl?.signal,
    });
  } catch { throw Object.assign(new Error(ERRORS.offline), { code: "offline" }); }
  finally { if (timer) clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const code = data?.error && ERRORS[data.error] ? data.error : "server";
    throw Object.assign(new Error(errorText(code)), { code, status: res.status });
  }
  return data || {};
}

// ---- What gets synced ----------------------------------------------------------------------------
/** The user's data on this device as {key: rawString}. */
export function collect(storage) {
  const data = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && isUserKey(k)) data[k] = storage.getItem(k);
  }
  return data;
}

export const hasUserData = data => Object.keys(data || {}).some(k => /^eco:(plan|harvests|journal|soiltest|calib|yard|prices)$/.test(k));

/** Merges two journals by entry id; the newer copy of each entry wins, deleted entries stay deleted. */
export function mergeJournals(a, b) {
  const byId = new Map();
  for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!e || typeof e.id !== "string") continue;
    const old = byId.get(e.id);
    if (!old || (+e.t || 0) > (+old.t || 0)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((x, y) => String(y.date).localeCompare(String(x.date)) || (+y.t || 0) - (+x.t || 0));
}

/**
 * What to store when the account's copy arrives. The account's copy wins for
 * settings and the plan; journal entries made on both devices are kept.
 * Returns {key: rawString | null} (null = remove the key here).
 */
export function mergeIn(local, server) {
  const out = {};
  for (const [k, v] of Object.entries(server || {})) {
    if (!isUserKey(k) || typeof v !== "string") continue;
    out[k] = v;
  }
  if (local["eco:journal"] || server?.["eco:journal"]) {
    const parse = s => { try { return JSON.parse(s); } catch { return []; } };
    out["eco:journal"] = JSON.stringify(mergeJournals(parse(local["eco:journal"]), parse(server?.["eco:journal"])));
  }
  for (const k of Object.keys(local)) if (!(k in out) && /^eco:(plan|harvests|soiltest|calib|yard|prices|settings)$/.test(k)) out[k] = null;
  return out;
}

export function applyTo(storage, pairs) {
  for (const [k, v] of Object.entries(pairs)) {
    if (!isUserKey(k)) continue;
    if (v === null) storage.removeItem(k); else storage.setItem(k, v);
  }
}

// ---- Session on this device ------------------------------------------------------------------------
const readJSON = (storage, k) => { try { return JSON.parse(storage.getItem(k) || "null"); } catch { return null; } };
export const session = storage => { const a = readJSON(storage, AUTH_KEY); return a && typeof a.token === "string" ? a : null; };
export const syncState = storage => ({ server: null, dirty: false, ...(readJSON(storage, SYNC_KEY) || {}) });
export const setSync = (storage, patch) => storage.setItem(SYNC_KEY, JSON.stringify({ ...syncState(storage), ...patch }));
export function signIn(storage, { token, email }) { storage.setItem(AUTH_KEY, JSON.stringify({ token, email })); }
export function signOutHere(storage) { storage.removeItem(AUTH_KEY); storage.removeItem(SYNC_KEY); }

/**
 * Decides what to do with the account's copy when the app opens:
 *   "none"  nothing new on either side
 *   "push"  only this device changed
 *   "pull"  only the account changed (another device saved since)
 *   "merge" both changed: take the account's copy, keep journal entries from both, then push
 */
export function plan(sync, serverUpdated) {
  const newer = !!serverUpdated && serverUpdated !== sync.server;
  if (newer) return sync.dirty ? "merge" : "pull";
  return sync.dirty ? "push" : "none";
}
