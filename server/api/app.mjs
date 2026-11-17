// EcoAnalytics account + assistant API (runs as a free Neon Function).
//
// Everything a signed-in gardener saves lives in one Postgres row per person,
// and the garden assistant calls Google's Gemini with a key that never leaves
// this server. No cookies: the app keeps a random session token and sends it
// as "Authorization: Bearer ...", which works on every browser, Safari included.
//
// handle(request, deps) is pure apart from the injected `db` and `fetch`, so it
// is tested without a network (tests/server.test.mjs).

import { scrypt as _scrypt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);

export const LIMITS = {
  passwordMin: 8,
  sessionDays: 180,
  dataBytes: 400_000,
  loginFailures: 8,         // per email or address, per 15 minutes
  signupsPerHour: 5,        // per address
  aiPerDay: 20,             // assistant messages + summaries per person per day
  contextChars: 6000,
  messageChars: 2000,
  messages: 16,
};

const ALLOWED_ORIGINS = [/^https:\/\/aaronhal223\.github\.io$/i, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sha256 = s => createHash("sha256").update(s).digest("hex");
const emailOk = e => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function checkSecret(secret, stored) {
  const [kind, salt, key] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(String(secret), Buffer.from(salt, "base64"), want.length, { N: 16384, r: 8, p: 1 });
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Easy-to-copy recovery code like 7KQX-M2PD-9RTA-HC4W (no 0/O or 1/I). */
export function recoveryCode() {
  const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ", b = randomBytes(16);
  const s = [...b].map(x => A[x % A.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}
const normCode = c => String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

function cors(origin) {
  if (!origin || !ALLOWED_ORIGINS.some(r => r.test(origin))) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-max-age": "86400", vary: "Origin" };
}

async function newSession(db, userId) {
  const token = randomBytes(32).toString("base64url");
  await db("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [sha256(token), userId, LIMITS.sessionDays]);
  return token;
}

async function userFrom(db, req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  const rows = await db("SELECT u.id, u.email, u.pass_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()", [sha256(m[1])]);
  return rows[0] ? { ...rows[0], tokenHash: sha256(m[1]) } : null;
}

async function tooMany(db, key, max, minutes) {
  const rows = await db("SELECT count(*)::int AS n FROM login_attempts WHERE key = $1 AND at > now() - make_interval(mins => $2)", [key, minutes]);
  return (rows[0]?.n ?? 0) >= max;
}
const note = (db, key) => db("INSERT INTO login_attempts (key) VALUES ($1)", [key]);

// ---- Assistant -----------------------------------------------------------------------------------
export const SYSTEM_PROMPT = `You are the garden assistant inside EcoAnalytics, a free app that works out a home gardener's soil, season, sun and money.
You get a summary of THIS gardener's garden from the app (location rounded, soil, beds, this week's weather and to-do list, harvest log). Use it: say "your beds", "your soil", and quote the app's numbers rather than inventing new ones. If something isn't in the summary, say so plainly and give general advice.
Be short and practical: a few sentences or a short list, plain words a beginner understands, cheapest fixes first (hand-picking, row cover, watering timing, compost) before anything bought. For any product, say to follow the label.
When asked to write something (a message to a neighbour, a post for a swap group, a question for the local extension office, a note to EcoAnalytics), write it ready to send, in the gardener's voice, without extra commentary.
Reply in the language the gardener writes in. You can't see photos or the screen. Never ask for or repeat an exact address, passwords or payment details.`;

export function geminiBody({ messages, context, system = SYSTEM_PROMPT, json: asJson = false, maxTokens = 700 }) {
  return {
    systemInstruction: { parts: [{ text: `${system}\n\n--- Garden summary from the app ---\n${context || "(none)"}` }] },
    contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4, ...(asJson ? { responseMimeType: "application/json" } : {}) },
  };
}

async function callGemini(fetchFn, env, body) {
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (r.status === 429) return { error: "busy" };
    if (!r.ok) return { error: "ai_failed", status: r.status };
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    return text ? { text } : { error: "ai_empty" };
  } catch { return { error: "ai_failed" }; } finally { clearTimeout(t); }
}

function cleanMessages(list, endOnUser = true) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(-LIMITS.messages).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .map(m => ({ role: m.role, text: m.text.slice(0, LIMITS.messageChars) }));
  if (endOnUser) while (out.length && out[0].role === "assistant") out.shift();   // Gemini wants the gardener to speak first
  return out.length && (!endOnUser || out[out.length - 1].role === "user") ? out : null;
}

async function useAi(db, userId) {
  const rows = await db(`INSERT INTO ai_usage (user_id, day, count) VALUES ($1, current_date, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET count = ai_usage.count + 1 RETURNING count`, [userId]);
  return rows[0]?.count ?? 1;
}

// ---- Router ----------------------------------------------------------------------------------------------
export async function handle(req, { db, env = {}, fetch: fetchFn = fetch }) {
  const origin = req.headers.get("origin");
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (req.method === "GET" && (path === "/" || path === "/health")) return json(200, { ok: true, assistant: !!env.GEMINI_API_KEY }, h);
  if (req.method !== "POST") return json(405, { error: "method" }, h);

  let body = {};
  try {
    const text = await req.text();
    if (text.length > LIMITS.dataBytes + 10_000) return json(413, { error: "too_big" }, h);
    body = text ? JSON.parse(text) : {};
  } catch { return json(400, { error: "bad_json" }, h); }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  try {
    // ---- Public routes ----
    if (path === "/signup") {
      const email = String(body.email || "").trim(), password = String(body.password || "");
      if (!emailOk(email)) return json(400, { error: "email" }, h);
      if (password.length < LIMITS.passwordMin || password.length > 200) return json(400, { error: "password" }, h);
      if (await tooMany(db, "signup:" + ip, LIMITS.signupsPerHour, 60)) return json(429, { error: "slow_down" }, h);
      await note(db, "signup:" + ip);
      const exists = await db("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email]);
      if (exists.length) return json(409, { error: "exists" }, h);
      const code = recoveryCode();
      const rows = await db("INSERT INTO users (email, pass_hash, recovery_hash) VALUES ($1, $2, $3) RETURNING id",
        [email, await hashSecret(password), await hashSecret(normCode(code))]);
      return json(200, { token: await newSession(db, rows[0].id), email, recoveryCode: code }, h);
    }
    if (path === "/login" || path === "/recover") {
      const email = String(body.email || "").trim();
      if (!emailOk(email)) return json(400, { error: "email" }, h);
      const keyE = "login:" + email.toLowerCase(), keyI = "loginip:" + ip;
      if (await tooMany(db, keyE, LIMITS.loginFailures, 15) || await tooMany(db, keyI, LIMITS.loginFailures * 3, 15)) return json(429, { error: "slow_down" }, h);
      const rows = await db("SELECT id, email, pass_hash, recovery_hash FROM users WHERE lower(email) = lower($1)", [email]);
      const u = rows[0];
      if (path === "/login") {
        const ok = u ? await checkSecret(String(body.password || ""), u.pass_hash) : (await hashSecret("x"), false);   // same timing either way
        if (!ok) { await note(db, keyE); await note(db, keyI); return json(401, { error: "wrong" }, h); }
        return json(200, { token: await newSession(db, u.id), email: u.email }, h);
      }
      const password = String(body.newPassword || "");
      if (password.length < LIMITS.passwordMin || password.length > 200) return json(400, { error: "password" }, h);
      const ok = u ? await checkSecret(normCode(body.recoveryCode), u.recovery_hash) : (await hashSecret("x"), false);
      if (!ok) { await note(db, keyE); await note(db, keyI); return json(401, { error: "wrong" }, h); }
      const code = recoveryCode();
      await db("UPDATE users SET pass_hash = $2, recovery_hash = $3 WHERE id = $1", [u.id, await hashSecret(password), await hashSecret(normCode(code))]);
      await db("DELETE FROM sessions WHERE user_id = $1", [u.id]);
      return json(200, { token: await newSession(db, u.id), email: u.email, recoveryCode: code }, h);
    }

    // ---- Signed-in routes ----
    const user = await userFrom(db, req);
    if (!user) return json(401, { error: "signed_out" }, h);

    if (path === "/me") {
      const d = await db("SELECT updated_at FROM user_data WHERE user_id = $1", [user.id]);
      return json(200, { email: user.email, updated_at: d[0]?.updated_at ?? null, assistant: !!env.GEMINI_API_KEY }, h);
    }
    if (path === "/logout") { await db("DELETE FROM sessions WHERE token_hash = $1", [user.tokenHash]); return json(200, { ok: true }, h); }
    if (path === "/pull") {
      const d = await db("SELECT data, updated_at FROM user_data WHERE user_id = $1", [user.id]);
      return json(200, { data: d[0]?.data ?? null, updated_at: d[0]?.updated_at ?? null }, h);
    }
    if (path === "/push") {
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return json(400, { error: "data" }, h);
      const text = JSON.stringify(body.data);
      if (text.length > LIMITS.dataBytes) return json(413, { error: "too_big" }, h);
      const rows = await db(`INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING updated_at`, [user.id, text]);
      return json(200, { updated_at: rows[0].updated_at }, h);
    }
    if (path === "/delete") {
      if (!(await checkSecret(String(body.password || ""), user.pass_hash))) return json(401, { error: "wrong" }, h);
      await db("DELETE FROM users WHERE id = $1", [user.id]);
      return json(200, { ok: true }, h);
    }
    if (path === "/chat" || path === "/summarize") {
      if (!env.GEMINI_API_KEY) return json(503, { error: "assistant_off" }, h);
      if (body.consent !== true) return json(400, { error: "consent" }, h);
      const messages = cleanMessages(body.messages, path === "/chat");
      if (!messages) return json(400, { error: "messages" }, h);
      const used = await useAi(db, user.id);
      if (used > LIMITS.aiPerDay) return json(429, { error: "daily_limit", limit: LIMITS.aiPerDay }, h);
      const context = String(body.context || "").slice(0, LIMITS.contextChars);
      if (path === "/chat") {
        const r = await callGemini(fetchFn, env, geminiBody({ messages, context }));
        return r.error ? json(r.error === "busy" ? 429 : 502, { error: r.error }, h) : json(200, { reply: r.text, left: Math.max(0, LIMITS.aiPerDay - used) }, h);
      }
      const transcript = messages.map(m => `${m.role === "user" ? "Gardener" : "Assistant"}: ${m.text}`).join("\n");
      const r = await callGemini(fetchFn, env, geminiBody({
        messages: [{ role: "user", text: `Summarise this conversation for the gardener's garden journal. Return JSON {"title": "...", "points": ["...", "..."]}: a title under 8 words and 2-5 short points with any decisions, advice to remember and things to do, in the gardener's language.\n\n${transcript}` }],
        context, json: true, maxTokens: 400,
      }));
      if (r.error) return json(r.error === "busy" ? 429 : 502, { error: r.error }, h);
      try {
        const o = JSON.parse(r.text);
        const points = (Array.isArray(o.points) ? o.points : []).map(String).filter(Boolean).slice(0, 6);
        return json(200, { title: String(o.title || "Garden assistant").slice(0, 80), points, left: Math.max(0, LIMITS.aiPerDay - used) }, h);
      } catch { return json(200, { title: "Garden assistant", points: [r.text.slice(0, 600)], left: Math.max(0, LIMITS.aiPerDay - used) }, h); }
    }
    return json(404, { error: "not_found" }, h);
  } catch (e) {
    return json(500, { error: "server" }, h);
  }
}
