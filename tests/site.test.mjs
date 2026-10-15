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
