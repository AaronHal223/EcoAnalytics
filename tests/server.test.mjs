// Account + assistant API, run against an in-memory stand-in for the Postgres tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, LIMITS, hashSecret, checkSecret, recoveryCode, geminiBody } from "../server/api/app.mjs";

function fakeDb() {
  const t = { users: [], sessions: [], user_data: [], ai_usage: [], attempts: [] };
  let id = 0;
  const now = () => new Date();
  const db = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT count(*)::int AS n FROM login_attempts")) return [{ n: t.attempts.filter(a => a.key === p[0]).length }];
    if (s.startsWith("INSERT INTO login_attempts")) { t.attempts.push({ key: p[0] }); return []; }
    if (s.startsWith("SELECT 1 FROM users")) return t.users.filter(u => u.email.toLowerCase() === p[0].toLowerCase()).map(() => ({ "?column?": 1 }));
    if (s.startsWith("INSERT INTO users")) { const u = { id: "u" + ++id, email: p[0], pass_hash: p[1], recovery_hash: p[2] }; t.users.push(u); return [{ id: u.id }]; }
    if (s.startsWith("INSERT INTO sessions")) { t.sessions.push({ token_hash: p[0], user_id: p[1] }); return []; }
    if (s.startsWith("SELECT id, email, pass_hash, recovery_hash FROM users")) return t.users.filter(u => u.email.toLowerCase() === p[0].toLowerCase());
    if (s.startsWith("SELECT u.id, u.email, u.pass_hash FROM sessions")) {
      const se = t.sessions.find(x => x.token_hash === p[0]); const u = se && t.users.find(x => x.id === se.user_id);
      return u ? [{ id: u.id, email: u.email, pass_hash: u.pass_hash }] : [];
    }
    if (s.startsWith("UPDATE users SET pass_hash")) { const u = t.users.find(x => x.id === p[0]); u.pass_hash = p[1]; u.recovery_hash = p[2]; return []; }
    if (s.startsWith("DELETE FROM sessions WHERE user_id")) { t.sessions = t.sessions.filter(x => x.user_id !== p[0]); return []; }
    if (s.startsWith("DELETE FROM sessions WHERE token_hash")) { t.sessions = t.sessions.filter(x => x.token_hash !== p[0]); return []; }
    if (s.startsWith("SELECT updated_at FROM user_data")) return t.user_data.filter(d => d.user_id === p[0]);
    if (s.startsWith("SELECT data, updated_at FROM user_data")) return t.user_data.filter(d => d.user_id === p[0]);
    if (s.startsWith("INSERT INTO user_data")) {
      const row = { user_id: p[0], data: JSON.parse(p[1]), updated_at: now().toISOString() };
      t.user_data = t.user_data.filter(d => d.user_id !== p[0]).concat(row); return [{ updated_at: row.updated_at }];
    }
    if (s.startsWith("DELETE FROM users")) { t.users = t.users.filter(u => u.id !== p[0]); t.sessions = t.sessions.filter(x => x.user_id !== p[0]); t.user_data = t.user_data.filter(d => d.user_id !== p[0]); return []; }
    if (s.startsWith("INSERT INTO ai_usage")) {
      let r = t.ai_usage.find(x => x.user_id === p[0]); if (!r) { r = { user_id: p[0], count: 0 }; t.ai_usage.push(r); }
      r.count++; return [{ count: r.count }];
    }
    throw new Error("unexpected SQL: " + s);
  };
  return { db, t };
}

const ORIGIN = "https://aaronhal223.github.io";
function call(deps, path, body, token, { method = "POST", origin = ORIGIN } = {}) {
  const headers = { "content-type": "application/json", origin };
  if (token) headers.authorization = "Bearer " + token;
  return handle(new Request("https://api.example" + path, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined }), deps)
    .then(async r => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json() }));
}

test("passwords and recovery codes are hashed with scrypt and checked in constant time", async () => {
  const h = await hashSecret("garden123");
  assert.match(h, /^scrypt\$/);
  assert.ok(await checkSecret("garden123", h));
  assert.ok(!(await checkSecret("garden124", h)));
  assert.ok(!(await checkSecret("x", "junk")));
  assert.match(recoveryCode(), /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
});

test("sign up, sign in, save and load data, sign out", async () => {
  const { db, t } = fakeDb(), deps = { db, env: {} };
  const up = await call(deps, "/signup", { email: "Grower@Example.com", password: "tomatoes1" });
  assert.equal(up.status, 200);
  assert.ok(up.body.token && up.body.recoveryCode);
  assert.equal(up.headers.get("access-control-allow-origin"), ORIGIN);
  assert.ok(!JSON.stringify(t.users).includes("tomatoes1"), "password never stored in plain text");
  assert.ok(!t.sessions.some(s => s.token_hash === up.body.token), "tokens stored hashed");
  assert.equal((await call(deps, "/signup", { email: "grower@example.com", password: "tomatoes1" })).status, 409);
  assert.equal((await call(deps, "/signup", { email: "nope", password: "tomatoes1" })).body.error, "email");
  assert.equal((await call(deps, "/signup", { email: "a@b.co", password: "short" })).body.error, "password");

  const tok = (await call(deps, "/login", { email: "grower@example.com", password: "tomatoes1" })).body.token;
  assert.ok(tok);
  assert.equal((await call(deps, "/login", { email: "grower@example.com", password: "wrong-one" })).status, 401);

  assert.deepEqual((await call(deps, "/pull", {}, tok)).body.data, null);
  const push = await call(deps, "/push", { data: { "eco:plan": "[]", "eco:journal": "[]" } }, tok);
  assert.equal(push.status, 200);
  assert.ok(push.body.updated_at);
  assert.deepEqual((await call(deps, "/pull", {}, tok)).body.data, { "eco:plan": "[]", "eco:journal": "[]" });
  assert.equal((await call(deps, "/me", {}, tok)).body.email, "Grower@Example.com");
  assert.equal((await call(deps, "/push", { data: [1, 2] }, tok)).status, 400);
  assert.equal((await call(deps, "/push", { data: { big: "x".repeat(LIMITS.dataBytes) } }, tok)).status, 413);

  await call(deps, "/logout", {}, tok);
  assert.equal((await call(deps, "/pull", {}, tok)).status, 401);
  assert.equal((await call(deps, "/pull", {}, "not-a-real-token-at-all-xx")).status, 401);
});

test("forgot password: the recovery code sets a new password and gives a new code", async () => {
  const { db } = fakeDb(), deps = { db, env: {} };
  const up = await call(deps, "/signup", { email: "a@b.co", password: "first-pass" });
  assert.equal((await call(deps, "/recover", { email: "a@b.co", recoveryCode: "AAAA-BBBB-CCCC-DDDD", newPassword: "second-pass" })).status, 401);
  const rec = await call(deps, "/recover", { email: "a@b.co", recoveryCode: up.body.recoveryCode.toLowerCase().replace(/-/g, " "), newPassword: "second-pass" });
  assert.equal(rec.status, 200);
  assert.notEqual(rec.body.recoveryCode, up.body.recoveryCode);
  assert.equal((await call(deps, "/pull", {}, up.body.token)).status, 401, "old sessions end");
  assert.equal((await call(deps, "/login", { email: "a@b.co", password: "second-pass" })).status, 200);
  assert.equal((await call(deps, "/login", { email: "a@b.co", password: "first-pass" })).status, 401);
});

test("repeated wrong passwords are slowed down", async () => {
  const { db } = fakeDb(), deps = { db, env: {} };
  await call(deps, "/signup", { email: "a@b.co", password: "right-pass" });
  for (let i = 0; i < LIMITS.loginFailures; i++) await call(deps, "/login", { email: "a@b.co", password: "nope-nope" });
  assert.equal((await call(deps, "/login", { email: "a@b.co", password: "right-pass" })).status, 429);
});

test("delete account needs the password and removes everything", async () => {
  const { db, t } = fakeDb(), deps = { db, env: {} };
  const tok = (await call(deps, "/signup", { email: "a@b.co", password: "right-pass" })).body.token;
  await call(deps, "/push", { data: { k: "v" } }, tok);
  assert.equal((await call(deps, "/delete", { password: "wrong" }, tok)).status, 401);
  assert.equal((await call(deps, "/delete", { password: "right-pass" }, tok)).status, 200);
  assert.equal(t.users.length + t.user_data.length + t.sessions.length, 0);
});

test("CORS: the app's site and localhost are allowed, others aren't; preflight answers", async () => {
  const { db } = fakeDb(), deps = { db, env: {} };
  const pre = await handle(new Request("https://api.example/push", { method: "OPTIONS", headers: { origin: ORIGIN } }), deps);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  const other = await call(deps, "/signup", { email: "x@y.co", password: "12345678" }, null, { origin: "https://evil.example" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const health = await handle(new Request("https://api.example/health"), deps);
  assert.deepEqual(await health.json(), { ok: true, assistant: false });
});

test("assistant: off without a key, needs consent, calls Gemini with the garden summary, daily limit", async () => {
  const { db } = fakeDb();
  const tok = (await call({ db, env: {} }, "/signup", { email: "a@b.co", password: "right-pass" })).body.token;
  const msgs = [{ role: "user", text: "When should I plant garlic?" }];
  assert.equal((await call({ db, env: {} }, "/chat", { messages: msgs, consent: true }, tok)).body.error, "assistant_off");

  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    const isSummary = JSON.parse(init.body).generationConfig.responseMimeType === "application/json";
    const text = isSummary ? JSON.stringify({ title: "Garlic timing", points: ["Plant cloves in October", "Mulch after planting"] }) : "Plant garlic about a week after your first frost, around Oct 20.";
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
  const deps = { db, env: { GEMINI_API_KEY: "test-key" }, fetch: fakeFetch };
  assert.equal((await call(deps, "/chat", { messages: msgs }, tok)).body.error, "consent");
  const r = await call(deps, "/chat", { messages: msgs, consent: true, context: "Location: about 40.4N. Soil: loam, pH 6.4." }, tok);
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /garlic/i);
  assert.equal(sent[0].init.headers["x-goog-api-key"], "test-key");
  assert.ok(!sent[0].url.includes("test-key"), "key in a header, not the URL");
  assert.match(sent[0].body.systemInstruction.parts[0].text, /pH 6\.4/);
  assert.equal(sent[0].body.contents[0].role, "user");

  const s = await call(deps, "/summarize", { messages: [...msgs, { role: "assistant", text: r.body.reply }], consent: true }, tok);
  assert.equal(s.body.title, "Garlic timing");
  assert.deepEqual(s.body.points, ["Plant cloves in October", "Mulch after planting"]);

  for (let i = 0; i < LIMITS.aiPerDay; i++) await call(deps, "/chat", { messages: msgs, consent: true }, tok);
  assert.equal((await call(deps, "/chat", { messages: msgs, consent: true }, tok)).body.error, "daily_limit");
  assert.equal((await call(deps, "/chat", { messages: [{ role: "assistant", text: "hi" }], consent: true }, tok)).status, 400);
});

test("gemini request shape: roles map to user/model, JSON mode for summaries", () => {
  const b = geminiBody({ messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }], context: "ctx", json: true });
  assert.deepEqual(b.contents.map(c => c.role), ["user", "model", "user"]);
  assert.equal(b.generationConfig.responseMimeType, "application/json");
  assert.match(b.systemInstruction.parts[0].text, /ctx$/);
});
