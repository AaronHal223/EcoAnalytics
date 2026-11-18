// Beginner mode: starter garden, plant status, today's jobs and lessons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { starterPicks, share, plantStatus, todayJobs, weekKey, weatherWords, EASY, emoji, plainName, sunOk, SPACES } from "../public/js/beginner.js";
import { LESSONS, unlockedCount, currentLesson, lessonText, lessonContext, LESSON_IDS } from "../public/js/lessons.js";
import { addNote, MOODS } from "../public/js/journal.js";

const cal = (now) => ({ crops: Object.entries(now).map(([id, n]) => ({ id, now: n })) });

test("starter garden: easy plants that suit the sun, plantable ones first, space shared out", () => {
  const calendar = cal({ lettuce: { action: "sow" }, radish: { action: "sow" }, cherry_tomato: { action: "later", start: 120 }, bush_bean: { action: "soon", start: 100 }, kale: { action: "sow" } });
  const full = starterPicks({ space: "bed", sun: "full", calendar });
  assert.equal(full.length, SPACES.bed.plants);
  assert.equal(full.reduce((a, p) => a + p.sqft, 0), SPACES.bed.sqft);
  assert.ok(full.every(p => EASY.includes(p.crop) && p.sun === 8));
  assert.ok(full.slice(0, 3).every(p => ["lettuce", "radish", "kale"].includes(p.crop)), "plantable-now first");
  const shade = starterPicks({ space: "pots", sun: "little", calendar });
  assert.ok(shade.every(p => sunOk(p.crop, 3) || ["lettuce", "arugula", "spinach", "kale", "chard", "parsley"].includes(p.crop)), "shade-tolerant only");
  assert.ok(!shade.some(p => ["zucchini", "potato"].includes(p.crop)), "nothing too big for pots");
  assert.deepEqual(share(["a", "b", "c"], 10).map(p => p.sqft), [4, 3, 3]);
  assert.equal(emoji("cherry_tomato"), "🍅");
  assert.equal(plainName("bush_bean"), "Green beans");
});

test("plant status in plain words", () => {
  assert.equal(plantStatus({ crop: "radish", sqft: 4 }, { now: { action: "sow" } }, "2026-04-01").text, "Plant now");
  assert.equal(plantStatus({ crop: "radish", sqft: 4 }, { now: { action: "later", text: "Next planting Mar 19" } }, "2026-11-18").text, "Plant from Mar 19");
  assert.equal(plantStatus({ crop: "radish", sqft: 4, planted: "2026-04-01" }, null, "2026-04-05").text, "Ready in about 24 days");
  assert.equal(plantStatus({ crop: "radish", sqft: 4, planted: "2026-04-01" }, null, "2026-04-22").kind, "growing");
  assert.equal(plantStatus({ crop: "radish", sqft: 4, planted: "2026-04-01" }, null, "2026-04-30").text, "Ready to pick!");
  assert.equal(plantStatus({ crop: "radish", sqft: 4, planted: "2026-04-01" }, null, "2026-08-01").kind, "done");
});

test("today's jobs: no watering chores before anything is planted, and a next-up note in the off season", () => {
  const actions = [{ kind: "water", title: "Water on Tue", detail: "x" }, { kind: "plant", title: "Last week to plant lettuce", detail: "y" }, { kind: "calm", title: "All calm" }];
  const calendar = cal({ lettuce: { action: "later", start: 78, text: "Next planting Mar 19" }, kale: { action: "later", start: 70, text: "Next planting Mar 11" } });
  let jobs = todayJobs({ actions, plan: [{ crop: "lettuce", sqft: 4 }], calendar, today: "2026-11-18" });
  assert.deepEqual(jobs.map(j => j.title), ["Last week to plant lettuce"]);
  jobs = todayJobs({ actions: [], plan: [{ crop: "lettuce", sqft: 4 }, { crop: "kale", sqft: 4 }], calendar, today: "2026-11-18" });
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].info);
  assert.equal(jobs[0].title, "Next up: your kale");
  jobs = todayJobs({ actions, plan: [{ crop: "lettuce", sqft: 4, planted: "2026-11-01" }], calendar, today: "2026-11-18" });
  assert.ok(jobs.some(j => j.title === "Water on Tue"), "watering once something grows");
  jobs = todayJobs({ actions: [], plan: [{ crop: "radish", sqft: 4 }], calendar: cal({ radish: { action: "sow" } }), today: "2026-04-01" });
  assert.equal(jobs[0].title, "Plant your radishes");
  assert.equal(weekKey(new Date(2026, 10, 18)), "2026-11-16");
  assert.equal(weekKey(new Date(2026, 10, 22)), "2026-11-16", "Sunday belongs to the week that started Monday");
});

test("weather in a sentence, in English and Spanish", () => {
  assert.equal(weatherWords({ tmax: 55.4, tmin: 30, rain_in: 0 }), "Cool and dry today, high 55°F, frost tonight");
  assert.equal(weatherWords({ tmax: 90, tmin: 70, rain_in: 0.5 }), "Hot with rain today, high 90°F");
  assert.equal(weatherWords({ tmax: 62, tmin: 50, rain_in: 0.1 }, "es"), "Hoy está templado con algo de lluvia, máxima 62°F");
  assert.equal(weatherWords(null), null);
});

test("lessons: two open on day one, one more each day, personalised, in both languages", () => {
  assert.equal(new Set(LESSON_IDS).size, LESSONS.length);
  assert.equal(unlockedCount(null), 2);
  assert.equal(unlockedCount("2026-11-10", new Date(2026, 10, 10, 20)), 2);
  assert.equal(unlockedCount("2026-11-10", new Date(2026, 10, 13, 8)), 5);
  assert.equal(unlockedCount("2020-01-01", new Date(2026, 0, 1)), LESSONS.length);
  let c = currentLesson({ started: "2026-11-10", done: [] }, new Date(2026, 10, 10));
  assert.equal(c.lesson.id, "start");
  c = currentLesson({ started: "2026-11-10", done: ["start", "sun"] }, new Date(2026, 10, 10));
  assert.equal(c.lesson, null);
  assert.ok(!c.finished);
  c = currentLesson({ started: "2026-11-10", done: LESSON_IDS }, new Date(2027, 0, 1));
  assert.ok(c.finished);
  const ctx = lessonContext({ place: "Princeton", climate: { last_spring_frost: "Apr 18", first_fall_frost: "Oct 25" }, soil: { values: { ph: { value: 5.4 } }, texture_class: "Silty clay loam" }, sunHours: 5 });
  const frost = lessonText(LESSONS.find(l => l.id === "frost"), ctx);
  assert.match(frost.body, /around Apr 18 .* around Oct 25/);
  assert.match(lessonText(LESSONS.find(l => l.id === "soil"), ctx).body, /clay-rich .*sour \(acidic\)/);
  assert.match(lessonText(LESSONS.find(l => l.id === "soil"), ctx, "es").body, /arcilloso.*ácido/);
  assert.match(lessonText(LESSONS.find(l => l.id === "sun"), ctx).body, /about 5 hours/);
  for (const l of LESSONS) for (const L of ["en", "es"]) {
    const t = lessonText(l, {}, L);
    assert.ok(t.title && t.body.length > 60 && !/undefined|null|\{/.test(t.body), `${l.id} ${L}`);
  }
});

test("diary moods", () => {
  const j = addNote([], { text: "", mood: "great" });
  assert.equal(j[0].mood, "great");
  assert.equal(addNote([], { text: "", mood: "furious" }), null);
  assert.equal(addNote([], { text: "hi", mood: "furious" })[0].mood, undefined);
  assert.equal(Object.keys(MOODS).length, 5);
});
