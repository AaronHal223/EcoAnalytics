// Neon Function entry: wires the API to the branch's Postgres (DATABASE_URL is injected by Neon).
// Queries go over Neon's SQL-over-HTTP endpoint (what @neondatabase/serverless uses), so the
// function has no dependencies and stays tiny.
import { handle } from "./app.mjs";

const INT = new Set([20, 21, 23]), JSONT = new Set([114, 3802]), BOOL = 16, TSTZ = 1184;
/** Postgres text timestamps ("2026-11-17 16:02:00.123456+00") as ISO strings every browser can read. */
export const isoTime = v => { const d = new Date(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")); return Number.isNaN(+d) ? v : d.toISOString(); };

export function makeDb(url = process.env.DATABASE_URL, fetchFn = fetch) {
  const host = new URL(url.replace(/^postgres(ql)?:/, "https:")).hostname;
  return async (query, params = []) => {
    const r = await fetchFn(`https://${host}/sql`, {
      method: "POST",
      headers: { "content-type": "application/json", "Neon-Connection-String": url, "Neon-Raw-Text-Output": "true", "Neon-Array-Mode": "false" },
      body: JSON.stringify({ query, params: params.map(p => (p === null || p === undefined ? null : String(p))) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.message || `SQL failed (${r.status})`);
    const types = Object.fromEntries((d.fields || []).map(f => [f.name, f.dataTypeID]));
    return (d.rows || []).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (v === null) return [k, null];
      if (INT.has(types[k])) return [k, Number(v)];
      if (JSONT.has(types[k])) return [k, JSON.parse(v)];
      if (types[k] === BOOL) return [k, v === "t" || v === "true"];
      if (types[k] === TSTZ) return [k, isoTime(v)];
      return [k, v];
    })));
  };
}

/** Runs a full sign-up → save → load → delete cycle against the real database and logs the result. */
async function selfTest(db) {
  const call = (path, body, token) => handle(new Request("https://self" + path, { method: "POST",
    headers: { "content-type": "application/json", origin: "https://aaronhal223.github.io", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body) }), { db, env: process.env }).then(async r => ({ s: r.status, b: await r.json() }));
  const email = `selftest-${Date.now()}@example.invalid`, out = {};
  const up = await call("/signup", { email, password: "selftest-password" }); out.signup = up.s;
  const tok = up.b.token;
  out.push = (await call("/push", { data: { "eco:plan": "[{\"crop\":\"kale\",\"sqft\":4}]" } }, tok)).s;
  const pull = await call("/pull", {}, tok); out.pull = pull.s; out.roundTrip = pull.b?.data?.["eco:plan"]?.includes("kale") === true;
  out.login = (await call("/login", { email, password: "selftest-password" })).s;
  out.badLogin = (await call("/login", { email, password: "wrong-password" })).s;
  out.recover = (await call("/recover", { email, recoveryCode: up.b.recoveryCode, newPassword: "selftest-password2" })).s;
  const tok2 = (await call("/login", { email, password: "selftest-password2" })).b.token;
  out.name = (await call("/name", { name: "Self Test" }, tok2)).s;
  const post = await call("/post", { text: "Self-test post, removed straight away", mood: "good" }, tok2); out.post = post.s;
  out.feed = (await call("/feed", {}, tok2)).b?.posts?.some(p => p.id === post.b?.post?.id) === true;
  out.like = (await call("/post/like", { id: post.b?.post?.id }, tok2)).b?.likes === 1;
  out.postDelete = (await call("/post/delete", { id: post.b?.post?.id }, tok2)).s;
  out.delete = (await call("/delete", { password: "selftest-password2" }, tok2)).s;
  out.assistant = !!process.env.GEMINI_API_KEY;
  console.log("SELFTEST " + JSON.stringify(out));
  return out;
}

let db = null;
export default {
  async fetch(request) {
    db ||= makeDb();
    if (process.env.SELFTEST === "1" && new URL(request.url).pathname === "/selftest") {
      try { return Response.json(await selfTest(db)); } catch (e) { console.log("SELFTEST ERROR " + (e?.message || e)); return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
    }
    return handle(request, { db, env: process.env });
  },
};
