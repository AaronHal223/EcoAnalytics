// Account + assistant API, run against an in-memory stand-in for the Postgres tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, LIMITS, hashSecret, checkSecret, recoveryCode, geminiBody, cleanName, cleanPost, cleanImage } from "../server/api/app.mjs";

function fakeDb() {
  const t = { users: [], sessions: [], user_data: [], ai_usage: [], attempts: [], posts: [], likes: [], reports: [] };
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
    if (s.startsWith("SELECT u.id, u.email, u.pass_hash, u.display_name FROM sessions")) {
      const se = t.sessions.find(x => x.token_hash === p[0]); const u = se && t.users.find(x => x.id === se.user_id);
      return u ? [{ id: u.id, email: u.email, pass_hash: u.pass_hash, display_name: u.display_name ?? null }] : [];
    }
    if (s.startsWith("UPDATE users SET display_name")) { t.users.find(x => x.id === p[0]).display_name = p[1]; return []; }
    if (s.startsWith("SELECT p.id, coalesce(u.display_name")) {
      return t.posts.filter(x => !x.hidden && (!p[0] || x.created_at < p[0])).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, p[2]).map(x => ({
        id: x.id, name: t.users.find(u => u.id === x.user_id)?.display_name || "Gardener", body: x.body, mood: x.mood, created_at: x.created_at, edited: !!x.edited_at,
        mine: x.user_id === p[1], likes: t.likes.filter(l => l.post_id === x.id).length, liked: t.likes.some(l => l.post_id === x.id && l.user_id === p[1]) }));
    }
    if (s.startsWith("SELECT count(*)::int AS n FROM posts")) return [{ n: t.posts.filter(x => x.user_id === p[0]).length }];
    if (s.startsWith("INSERT INTO posts")) {
      const x = { id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`, user_id: p[0], body: p[1], mood: p[2], created_at: new Date(Date.now() + id).toISOString(), hidden: false };
      t.posts.push(x); return [{ id: x.id, created_at: x.created_at }];
    }
    if (s.startsWith("UPDATE posts SET body")) { const x = t.posts.find(y => y.id === p[0] && y.user_id === p[1]); if (!x) return []; x.body = p[2]; x.edited_at = 1; return [{ id: x.id }]; }
    if (s.startsWith("DELETE FROM posts")) { const x = t.posts.find(y => y.id === p[0] && (y.user_id === p[1] || p[2])); if (!x) return []; t.posts = t.posts.filter(y => y !== x); return [{ id: x.id }]; }
    if (s.startsWith("DELETE FROM post_likes")) { const had = t.likes.some(l => l.post_id === p[0] && l.user_id === p[1]); t.likes = t.likes.filter(l => !(l.post_id === p[0] && l.user_id === p[1])); return had ? [{ post_id: p[0] }] : []; }
    if (s.startsWith("INSERT INTO post_likes")) { if (!t.posts.some(x => x.id === p[0] && !x.hidden)) return []; t.likes.push({ post_id: p[0], user_id: p[1] }); return [{ post_id: p[0] }]; }
    if (s.startsWith("SELECT count(*)::int AS n FROM post_likes")) return [{ n: t.likes.filter(l => l.post_id === p[0]).length }];
    if (s.startsWith("INSERT INTO post_reports")) { if (!t.posts.some(x => x.id === p[0]) || t.reports.some(r => r.post_id === p[0] && r.user_id === p[1])) return []; t.reports.push({ post_id: p[0], user_id: p[1] }); return [{ post_id: p[0] }]; }
    if (s.startsWith("SELECT count(*)::int AS n FROM post_reports")) return [{ n: t.reports.filter(r => r.post_id === p[0]).length }];
    if (s.startsWith("UPDATE posts SET hidden")) { t.posts.find(x => x.id === p[0]).hidden = true; return []; }
    if (s.startsWith("UPDATE users SET pass_hash")) { const u = t.users.find(x => x.id === p[0]); u.pass_hash = p[1]; u.recovery_hash = p[2]; return []; }
    if (s.startsWith("DELETE FROM sessions WHERE user_id")) { t.sessions = t.sessions.filter(x => x.user_id !== p[0]); return []; }
    if (s.startsWith("DELETE FROM sessions WHERE token_hash")) { t.sessions = t.sessions.filter(x => x.token_hash !== p[0]); return []; }
    if (s.startsWith("SELECT updated_at FROM user_data")) return t.user_data.filter(d => d.user_id === p[0]);
    if (s.startsWith("SELECT data, updated_at FROM user_data")) return t.user_data.filter(d => d.user_id === p[0]);
    if (s.startsWith("INSERT INTO user_data")) {
      const row = { user_id: p[0], data: JSON.parse(p[1]), updated_at: now().toISOString() };
      t.user_data = t.user_data.filter(d => d.user_id !== p[0]).concat(row); return [{ updated_at: row.updated_at }];
    }
    if (s.startsWith("DELETE FROM users")) { t.posts = t.posts.filter(x => x.user_id !== p[0]); t.users = t.users.filter(u => u.id !== p[0]); t.sessions = t.sessions.filter(x => x.user_id !== p[0]); t.user_data = t.user_data.filter(d => d.user_id !== p[0]); return []; }
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

async function member(deps, email) {
  const r = await call(deps, "/signup", { email, password: "tomatoes1" }, null, { origin: ORIGIN });
  return r.body.token;
}

test("community: names, posting, the feed, likes, editing and deleting your own", async () => {
  const { db, t } = fakeDb(), deps = { db, env: {} };
  const a = await member(deps, "a@ex.co"), b = await member(deps, "b@ex.co");
  assert.equal((await call(deps, "/post", { text: "First tomatoes!" }, a)).body.error, "need_name", "a public name comes first");
  assert.equal((await call(deps, "/name", { name: "a@ex.co" }, a)).body.error, "name", "no emails as names");
  assert.equal((await call(deps, "/name", { name: "  Rosa   M. " }, a)).body.name, "Rosa M.");
  assert.equal((await call(deps, "/me", {}, a)).body.name, "Rosa M.");
  assert.equal((await call(deps, "/post", { text: "buy cheap seeds at www.spam.example" }, a)).body.error, "links");
  assert.equal((await call(deps, "/post", { text: "x".repeat(1001) }, a)).body.error, "post");
  const p = await call(deps, "/post", { text: "First tomatoes!\n\n\n\nSo happy", mood: "great" }, a);
  assert.equal(p.status, 200);
  assert.equal(p.body.post.body, "First tomatoes!\n\nSo happy");
  assert.equal(p.body.post.mood, "great");
  assert.equal((await call(deps, "/post", { text: "hmm", mood: "angry-face" }, a)).body.post.mood, null);
  const anon = await call(deps, "/feed", {});
  assert.equal(anon.status, 200, "anyone can read");
  assert.equal(anon.body.posts.length, 2);
  assert.equal(anon.body.posts[1].name, "Rosa M.");
  assert.ok(!JSON.stringify(anon.body).includes("a@ex.co"), "emails never appear in the feed");
  const id = p.body.post.id;
  assert.deepEqual((await call(deps, "/post/like", { id }, b)).body, { liked: true, likes: 1 });
  assert.equal((await call(deps, "/feed", {}, b)).body.posts.find(x => x.id === id).liked, true);
  assert.deepEqual((await call(deps, "/post/like", { id }, b)).body, { liked: false, likes: 0 });
  assert.equal((await call(deps, "/post/edit", { id, text: "Hijacked" }, b)).status, 404, "can't edit someone else's post");
  assert.equal((await call(deps, "/post/delete", { id }, b)).status, 404, "can't delete someone else's post");
  assert.equal((await call(deps, "/post/edit", { id, text: "First ripe tomatoes!" }, a)).body.body, "First ripe tomatoes!");
  const mine = (await call(deps, "/feed", {}, a)).body.posts.find(x => x.id === id);
  assert.ok(mine.mine && mine.canDelete && mine.edited);
  assert.equal((await call(deps, "/post/like", { id: "not-a-uuid" }, b)).body.error, "post_id");
  assert.equal((await call(deps, "/post", { text: "x" })).status, 401, "posting needs an account");
  assert.equal((await call(deps, "/post/delete", { id }, a)).status, 200);
  assert.equal((await call(deps, "/feed", {})).body.posts.length, 1);
  for (let i = 0; i < LIMITS.postsPerDay; i++) await call(deps, "/post", { text: "post " + i }, a);
  assert.equal((await call(deps, "/post", { text: "one too many" }, a)).body.error, "post_limit");
  assert.equal(t.posts.filter(x => x.user_id === t.users[0].id).length, LIMITS.postsPerDay);
});

test("community: reports hide a post, the owner's admin can remove anything, deleting an account removes its posts", async () => {
  const { db, t } = fakeDb(), env = { ADMIN_EMAILS: "boss@ex.co" }, deps = { db, env };
  const a = await member(deps, "a@ex.co");
  await call(deps, "/name", { name: "Ann" }, a);
  const id = (await call(deps, "/post", { text: "Something rude" }, a)).body.post.id;
  const others = [];
  for (const e of ["r1@ex.co", "r2@ex.co", "r3@ex.co"]) others.push(await member(deps, e));
  assert.equal((await call(deps, "/post/report", { id }, others[0])).body.hidden, false);
  assert.equal((await call(deps, "/post/report", { id }, others[0])).body.counted, false, "one report per person");
  await call(deps, "/post/report", { id }, others[1]);
  assert.equal((await call(deps, "/post/report", { id }, others[2])).body.hidden, true);
  assert.equal((await call(deps, "/feed", {})).body.posts.length, 0);
  const id2 = (await call(deps, "/post", { text: "Another" }, a)).body.post.id;
  const boss = await member(deps, "boss@ex.co");
  assert.equal((await call(deps, "/feed", {}, boss)).body.posts[0].canDelete, true);
  assert.equal((await call(deps, "/post/delete", { id: id2 }, boss)).status, 200);
  await call(deps, "/post", { text: "Last one" }, a);
  await call(deps, "/delete", { password: "tomatoes1" }, a);
  assert.equal(t.posts.length, 0);
});

test("photos: only small JPEG/PNG/WebP images go to the assistant, attached to the question", async () => {
  assert.equal(cleanImage(null), null);
  assert.equal(cleanImage({ mime: "image/gif", data: "AAAA" }), undefined);
  assert.equal(cleanImage({ mime: "image/jpeg", data: "not base64!" }), undefined);
  assert.equal(cleanImage({ mime: "image/jpeg", data: "A".repeat(LIMITS.imageChars + 4) }), undefined);
  assert.deepEqual(cleanImage({ mime: "image/jpeg", data: "QUJD" }), { mime: "image/jpeg", data: "QUJD" });
  const g = geminiBody({ messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "yo" }, { role: "user", text: "what is this?" }], context: "c", image: { mime: "image/png", data: "QUJD" } });
  assert.deepEqual(g.contents[2].parts[0], { inline_data: { mime_type: "image/png", data: "QUJD" } });
  assert.equal(g.contents[0].parts.length, 1);
  const { db } = fakeDb();
  let sent;
  const deps = { db, env: { GEMINI_API_KEY: "k" }, fetch: async (u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Looks like early blight." }] } }] })); } };
  const tok = await member(deps, "p@ex.co");
  const r = await call(deps, "/chat", { messages: [{ role: "user", text: "What's wrong?" }], context: "", consent: true, image: { mime: "image/jpeg", data: "QUJD" } }, tok);
  assert.equal(r.body.reply, "Looks like early blight.");
  assert.equal(sent.contents[0].parts[0].inline_data.mime_type, "image/jpeg");
  assert.equal((await call(deps, "/chat", { messages: [{ role: "user", text: "x" }], consent: true, image: { mime: "text/html", data: "QUJD" } }, tok)).body.error, "photo");
  assert.equal(cleanName("x"), null);
  assert.equal(cleanName("José Ñ"), "José Ñ");
  assert.equal(cleanPost("  hi  ").text, "hi");
});

test("without a visitor address, sign-ups share a looser limit instead of locking everyone out", async () => {
  const { db } = fakeDb(), deps = { db, env: {} };
  for (let i = 0; i < LIMITS.signupsPerHour + 2; i++) assert.equal((await call(deps, "/signup", { email: `n${i}@ex.co`, password: "tomatoes1" })).status, 200);
});

test("database timestamps come back as ISO strings Safari can read", async () => {
  const { makeDb } = await import("../server/api/index.mjs");
  const db = makeDb("postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb", async (url, o) => {
    assert.equal(url, "https://ep-x.us-east-2.aws.neon.tech/sql");
    assert.deepEqual(JSON.parse(o.body).params, ["1", null, "true"]);
    return new Response(JSON.stringify({ fields: [{ name: "at", dataTypeID: 1184 }, { name: "n", dataTypeID: 23 }, { name: "ok", dataTypeID: 16 }, { name: "d", dataTypeID: 3802 }],
      rows: [{ at: "2026-11-17 16:02:00.123456+00", n: "4", ok: "t", d: '{"a":1}' }] }));
  });
  assert.deepEqual(await db("SELECT", [1, null, true]), [{ at: "2026-11-17T16:02:00.123Z", n: 4, ok: true, d: { a: 1 } }]);
});
