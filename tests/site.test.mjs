// Checks on the published site itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const PUB = path.join(ROOT, "public");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test("every file the page and service worker reference exists", () => {
  const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  const sw = fs.readFileSync(path.join(PUB, "sw.js"), "utf8");
  const shell = [...sw.matchAll(/"\.\/([^"]+)"/g)].map(m => m[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(PUB, "manifest.webmanifest"), "utf8"));
  for (const f of [...refs, ...shell, ...manifest.icons.map(i => i.src)]) {
    assert.ok(fs.existsSync(path.join(PUB, f)), `missing ${f}`);
  }
});

test("every module import resolves", () => {
  for (const f of walk(path.join(PUB, "js"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), `${path.basename(f)} imports missing ${m[1]}`);
    }
  }
});

test("only HTTPS data sources (the site is served over HTTPS)", () => {
  for (const f of walk(path.join(PUB, "js"))) {
    const insecure = fs.readFileSync(f, "utf8").match(/["'`]http:\/\/[^"'`]+/);
    assert.equal(insecure, null, `${path.basename(f)} uses ${insecure?.[0]}`);
  }
});

test("no poultry or egg tracking anywhere", () => {
  const re = /\b(eggs?|poultry|chickens?|flocks?|hens?)\b/i;
  for (const f of walk(PUB).filter(f => /\.(js|html|css|json|webmanifest)$/.test(f) && !f.includes("vendor"))) {
    const m = fs.readFileSync(f, "utf8").match(re);
    assert.equal(m, null, `${m?.[0]} in ${path.relative(ROOT, f)}`);
  }
});

test("Render blueprint publishes the public folder and runs tests", () => {
  const y = fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8");
  assert.match(y, /runtime: static/);
  assert.match(y, /staticPublishPath: \.\/public/);
  assert.match(y, /buildCommand: npm test/);
});

test("every element id the page script looks up exists in index.html", () => {
  const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const js = fs.readFileSync(path.join(PUB, "js/app.js"), "utf8");
  const used = new Set();
  for (const m of js.matchAll(/\$\$?\("#([A-Za-z][\w-]*)(?:"\s*[,)]|[ \[.:])/g)) used.add(m[1]);   // $("#id") and $("#id child ...")
  for (const m of js.matchAll(/\[\s*(?:"#[\w-]+"(?:,\s*)?)+\s*\]/g)) for (const x of m[0].matchAll(/"#([\w-]+)"/g)) used.add(x[1]);
  assert.ok(used.size > 40, `only found ${used.size} ids; the pattern may be broken`);
  for (const id of used) assert.ok(ids.has(id), `app.js uses #${id} but index.html has no such id`);
});

test("every tab button has a matching section, and ids are unique", () => {
  const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.ok(tabs.includes("calendar"));
  for (const t of tabs) assert.ok(html.includes(`id="tab-${t}"`), `no section for tab ${t}`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
});

test("the service worker precaches every module the page loads", () => {
  const sw = fs.readFileSync(path.join(PUB, "sw.js"), "utf8");
  for (const f of walk(path.join(PUB, "js"))) {
    const rel = "./" + path.relative(PUB, f).replace(/\\/g, "/");
    assert.ok(sw.includes(`"${rel}"`), `sw.js SHELL is missing ${rel}`);
  }
});
