// Account sync rules and the garden journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, mergeIn, mergeJournals, applyTo, plan, call, hasUserData, session, signIn, signOutHere, setSync, syncState, AUTH_KEY } from "../public/js/account.js";
import { dailyEntry, upsertDaily, addNote, editEntry, deleteEntry, visible, planChanges, bedSnapshot, weatherLine, assistantContext, toText, trim, KEEP } from "../public/js/journal.js";

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m,
  };
}

test("only the user's own data is synced, never sign-in or cached lookups", () => {
  const s = memStorage({ "eco:plan": "[]", "eco:forecast:1,2": "{}", "eco:research:v1:x": "{}", [AUTH_KEY]: '{"token":"t"}', other: "1" });
  assert.deepEqual(Object.keys(collect(s)), ["eco:plan"]);
});

test("the account's copy wins, journals from both devices are kept", () => {
  const j = (id, t, date = "2026-11-01") => ({ id, t, date, kind: "note", title: id, lines: ["x"] });
  const local = { "eco:plan": '[{"crop":"kale","sqft":4}]', "eco:journal": JSON.stringify([j("a", 1), j("b", 5)]), "eco:yard": "{}" };
  const server = { "eco:plan": '[{"crop":"basil","sqft":2}]', "eco:journal": JSON.stringify([j("b", 9), j("c", 2)]), "eco:auth": "nope", "eco:research:x": "{}" };
  const out = mergeIn(local, server);
  assert.equal(out["eco:plan"], server["eco:plan"]);
  assert.deepEqual(JSON.parse(out["eco:journal"]).map(e => `${e.id}${e.t}`).sort(), ["a1", "b9", "c2"]);
  assert.equal(out["eco:yard"], null, "a yard the account doesn't have is removed here");
  assert.ok(!("eco:research:x" in out));
  const s = memStorage(local);
  applyTo(s, out);
  assert.equal(s.getItem("eco:yard"), null);
  assert.equal(s.getItem("eco:plan"), server["eco:plan"]);
});

test("a deleted journal entry stays deleted after syncing", () => {
  const a = [{ id: "n1", date: "2026-11-02", t: 1, kind: "note", title: "x", lines: ["y"] }];
  const b = deleteEntry(a, "n1", 2);
  assert.equal(visible(mergeJournals(a, b)).length, 0);
  assert.equal(visible(mergeJournals(b, a)).length, 0);
});

test("what to do when the app opens", () => {
  assert.equal(plan({ server: "t1", dirty: false }, "t1"), "none");
  assert.equal(plan({ server: "t1", dirty: true }, "t1"), "push");
  assert.equal(plan({ server: "t1", dirty: false }, "t2"), "pull");
  assert.equal(plan({ server: "t1", dirty: true }, "t2"), "merge");
  assert.equal(plan({ server: null, dirty: true }, null), "push");
  assert.ok(hasUserData({ "eco:journal": "[]" }));
  assert.ok(!hasUserData({ "eco:tab": '"soil"', "eco:units": '"us"' }));
});

test("sign-in is kept on this device and removed on sign out", () => {
  const s = memStorage();
  assert.equal(session(s), null);
  signIn(s, { token: "abc", email: "a@b.co", recoveryCode: "SECRET" });
  assert.deepEqual(session(s), { token: "abc", email: "a@b.co" });
  setSync(s, { dirty: true });
  assert.equal(syncState(s).dirty, true);
  signOutHere(s);
  assert.equal(session(s), null);
  assert.equal(syncState(s).dirty, false);
});

test("API errors come back as plain-language messages", async () => {
  const fake = (status, body) => async (url, opts) => { fake.last = { url, opts }; return { ok: status < 400, status, json: async () => body }; };
  let f = fake(200, { token: "t" });
  assert.deepEqual(await call("/login", { email: "a" }, { fetchFn: f, base: "https://x" }), { token: "t" });
  f = fake(401, { error: "wrong" });
  await assert.rejects(call("/login", {}, { fetchFn: f }), e => e.code === "wrong" && /don't match/.test(e.message));
  f = fake(500, null);
  await assert.rejects(call("/pull", {}, { fetchFn: f, token: "t" }), e => e.code === "server");
  await assert.rejects(call("/pull", {}, { fetchFn: async () => { throw new TypeError("network"); } }), e => e.code === "offline");
  let seen;
  await call("/pull", {}, { token: "tok", fetchFn: async (u, o) => { seen = o; return { ok: true, status: 200, json: async () => ({}) }; } });
  assert.equal(seen.headers.authorization, "Bearer tok");
  await call("/health", undefined, { fetchFn: async (u, o) => { seen = o; return { ok: true, status: 200, json: async () => ({}) }; } });
  assert.equal(seen.method, "GET");
});

const DAYS = [{ date: "2026-11-17", tmax: 61.4, tmin: 38.2, rain_in: 0.2, pop: 70 }, { date: "2026-11-18", tmax: 55, tmin: 30, rain_in: 0, pop: 5 }];
const ACTS = [{ kind: "frost", title: "Cover the kale before Wednesday night", detail: "low 30°F" }, { kind: "calm", title: "All calm", detail: "" }];

test("daily update: weather, jobs, harvests since last time and bed changes", () => {
  assert.equal(weatherLine(DAYS[0]), "Weather: high 61°F, low 38°F, 0.2 in rain (70% chance)");
  assert.equal(weatherLine(DAYS[1]), "Weather: high 55°F, low 30°F, dry");
  assert.equal(weatherLine(null), null);
  const log = [{ crop: "kale", lb: 1.2, date: "2026-11-15" }, { crop: "kale", lb: 0.5, date: "2026-11-17" }, { crop: "kale", lb: 9, date: "2026-11-10" }];
  const e = dailyEntry({ date: "2026-11-17", days: DAYS, actions: ACTS, log, since: "2026-11-12", before: { kale: 8, lettuce: 4 }, plan: [{ crop: "kale", sqft: 10 }, { crop: "basil", sqft: 2 }] }, 5);
  assert.equal(e.id, "auto-2026-11-17");
  assert.deepEqual(e.lines, [
    "Weather: high 61°F, low 38°F, 0.2 in rain (70% chance)",
    "To do: Cover the kale before Wednesday night",
    "Picked 1.7 lb of kale",
    "Beds: Kale: 8 sq ft → 10 sq ft",
    "Beds: Added Basil (2 sq ft)",
    "Beds: Removed Lettuce",
  ]);
  const quiet = dailyEntry({ date: "2026-11-18", days: null, actions: [] });
  assert.deepEqual(quiet.lines, ["Nothing urgent in the garden this week"]);
  assert.deepEqual(planChanges(null, bedSnapshot([{ crop: "kale", sqft: 4 }])), []);
});

test("today's update refreshes itself until you edit it, and never comes back once deleted", () => {
  const inputs = { date: "2026-11-17", days: null, actions: ACTS, plan: [{ crop: "kale", sqft: 4 }] };
  let j = upsertDaily([], inputs, { now: 1 });
  assert.equal(visible(j).length, 1);
  assert.equal(upsertDaily(j, inputs, { now: 2 }), j, "nothing changed: same array, no save");
  j = upsertDaily(j, { ...inputs, days: DAYS }, { now: 3 });
  assert.match(j[0].lines[0], /^Weather/);
  j = editEntry(j, "auto-2026-11-17", { text: "My own words\n\nsecond line" }, 4);
  assert.deepEqual(j[0].lines, ["My own words", "", "second line"]);
  assert.equal(upsertDaily(j, { ...inputs, actions: [] }, { now: 5 }), j, "edited entries are left alone");
  j = deleteEntry(j, "auto-2026-11-17", 6);
  assert.equal(visible(upsertDaily(j, inputs, { now: 7 })).length, 0);
  // Next day compares with the previous automatic entry.
  let k = upsertDaily([], inputs, { now: 1 });
  k = upsertDaily(k, { ...inputs, date: "2026-11-18", plan: [{ crop: "kale", sqft: 6 }] }, { now: 2 });
  assert.ok(k[0].lines.includes("Beds: Kale: 4 sq ft → 6 sq ft"));
  // Lines go through the translator.
  const t = upsertDaily([], inputs, { localize: s => s.toUpperCase() });
  assert.equal(t[0].title, "DAILY UPDATE");
});

test("notes: empty ones are refused, long ones are capped, the journal can't grow forever", () => {
  assert.equal(addNote([], { text: "   \n " }), null);
  const j = addNote([], { text: "Planted garlic\nby the fence", date: "2026-11-17" }, 9);
  assert.equal(j[0].kind, "note");
  assert.deepEqual(j[0].lines, ["Planted garlic", "by the fence"]);
  assert.match(toText(j), /2026-11-17 · Note\n {2}Planted garlic/);
  const many = Array.from({ length: KEEP + 50 }, (_, i) => ({ id: "n" + i, date: "2026-01-01", t: i, kind: "note", title: "x", lines: ["y"] }));
  assert.equal(trim(many).length, KEEP);
  assert.equal(trim(many)[0].id, "n" + (KEEP + 49), "newest kept");
});

test("the assistant is told about the garden but not the address", () => {
  const soil = { values: { ph: { value: 6.4 }, organic_matter_pct: { value: 3.1 }, p_ppm: { value: 22 }, k_ppm: { value: 140 } }, texture_class: "loam" };
  const txt = assistantContext({
    place: "Springfield, Illinois", lat: 39.8, climate: { last_spring_frost: "Apr 18", first_fall_frost: "Oct 20", frost_free_days: 185 }, soil,
    plan: [{ crop: "kale", sqft: 4 }], actions: ACTS, log: [{ crop: "kale", lb: 2, date: "2026-10-01" }],
    journal: addNote([], { text: "Aphids on the kale" }), year: 2026, units: "metric", language: "es",
  });
  assert.match(txt, /Springfield, Illinois \(latitude about 40°, northern hemisphere\)/);
  assert.match(txt, /pH 6.4, organic matter 3.1%, phosphorus 22 ppm, potassium 140 ppm, texture loam/);
  assert.match(txt, /Beds: Kale 4 sq ft/);
  assert.match(txt, /Cover the kale/);
  assert.doesNotMatch(txt, /All calm/);
  assert.match(txt, /Picked this year: Kale 2 lb/);
  assert.match(txt, /metric units; reply in Spanish/);
  assert.match(txt, /Aphids on the kale/);
  assert.ok(assistantContext({ plan: [], journal: Array.from({ length: 50 }, (_, i) => ({ id: "x" + i, date: "2026-01-01", title: "t", kind: "note", lines: ["z".repeat(500)] })) }).length <= 5800);
});
