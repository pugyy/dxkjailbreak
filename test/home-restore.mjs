import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { beginHomeInstall, recordHomeWrites, restoreOwnedHome } from "../lib/home-restore.js";
import { resetToOriginal } from "../lib/rules.js";
import { collectCleanupDirs, dependenciesSynced, listInstalledProfiles } from "../lib/uninstall.js";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-restore-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "dxkjailbreak");
  const parent = path.join(state, "backups");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "20261119121212-"));
  const original = path.join(dir, "AGENTS.md");
  fs.writeFileSync(original, "before");
  const stamp = beginHomeInstall(state, dir);
  const files = { "AGENTS.md": original, "prompt-inject.md": "absent", "AGENTS.security.md": original };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ stamp, files }));
  const values = { "AGENTS.md": "installed1", "prompt-inject.md": "installed2" };
  for (const [name, bytes] of Object.entries(values)) fs.writeFileSync(path.join(home, name), bytes);
  return { home, state, parent, stamp, values };
}

test("restore owned bytes, remove owned creation, and retain unrelated files", t => {
  const { home, state, parent, stamp, values } = fixture(t);
  const security = path.join(home, "AGENTS.security.md");
  fs.writeFileSync(security, "keep");
  recordHomeWrites(state, stamp, values);
  restoreOwnedHome(home, () => {});
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "before");
  assert.equal(fs.existsSync(path.join(home, "prompt-inject.md")), false);
  assert.equal(fs.readFileSync(security, "utf8"), "keep");
  fs.writeFileSync(path.join(home, "AGENTS.md"), "later");
  restoreOwnedHome(home, () => {});
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "later");
  const next = fs.mkdtempSync(path.join(parent, "20261119121212-"));
  assert.notEqual(beginHomeInstall(state, next), stamp);
});

test("retain edits and files without installation fingerprints", t => {
  const { home, state, stamp, values } = fixture(t);
  recordHomeWrites(state, stamp, values);
  const file = path.join(home, "AGENTS.md");
  fs.writeFileSync(file, "edited");
  restoreOwnedHome(home, () => {});
  assert.equal(fs.readFileSync(file, "utf8"), "edited");
  const legacy = fixture(t);
  restoreOwnedHome(legacy.home, () => {});
  assert.equal(fs.readFileSync(path.join(legacy.home, "AGENTS.md"), "utf8"), legacy.values["AGENTS.md"]);
});

test("uninstall retains user rules and backups, restoring only the matching active rule", async t => {
  const { home, state } = fixture(t);
  const rules = path.join(home, "rules");
  fs.mkdirSync(rules);
  const target = path.join(home, "AGENTS.md");
  const backup = target + ".dsh-purge-rule.bak";
  fs.writeFileSync(backup, "original");
  fs.writeFileSync(path.join(rules, "state.json"), JSON.stringify({ active: "example" }));
  fs.writeFileSync(path.join(rules, "example.md"), "active");
  fs.writeFileSync(path.join(rules, "custom.md"), "user file");
  fs.writeFileSync(target, "user edit");
  const preserved = await resetToOriginal(home, { preserveEdits: true });
  assert.deepEqual(preserved.skipped, [target]);
  assert.equal(fs.readFileSync(target, "utf8"), "user edit");
  assert.equal(fs.readFileSync(backup, "utf8"), "original");
  fs.writeFileSync(target, "active");
  const restored = await resetToOriginal(home, { preserveEdits: true });
  assert.deepEqual(restored.restored, [target]);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(rules, "custom.md"), "utf8"), "user file");
  const cleanup = collectCleanupDirs([], home);
  assert.ok(!cleanup.includes(state) && !cleanup.includes(rules));
});

test("a restored dependency stays outside the cleanup plan", t => {
  const { home } = fixture(t);
  const dir = path.join(home, "profiles", "desktop");
  const pkg = path.join(dir, "node_modules", "dxkjailbreak");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "dxkjailbreak" }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { dxkjailbreak: "1.0.0" } }));
  assert.ok(!collectCleanupDirs([{ dir }], home).includes(pkg));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
  assert.ok(collectCleanupDirs([{ dir }], home).includes(pkg));
});

test("an invalid second backup leaves both home files and the active baseline intact", t => {
  const { home, state, stamp, values } = fixture(t);
  recordHomeWrites(state, stamp, values);
  const file = path.join(state, "backups", stamp, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.files["prompt-inject.md"] = path.join(state, "missing");
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => restoreOwnedHome(home));
  for (const [name, bytes] of Object.entries(values)) assert.equal(fs.readFileSync(path.join(home, name), "utf8"), bytes);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(state, "baseline.json"))).retired);
});

test("uninstall detects stale direct and installed importers even after registration was removed", t => {
  const { home } = fixture(t);
  const dir = path.join(home, "profiles", "desktop");
  const actual = path.join(dir, "node_modules", ".pnpm", "lock.yaml");
  fs.mkdirSync(path.dirname(actual), { recursive: true });
  const p = { name: "desktop", dir, pkgPath: path.join(dir, "package.json") };
  fs.writeFileSync(p.pkgPath, JSON.stringify({ dependencies: {} }));
  const lock = path.join(dir, "pnpm-lock.yaml");
  const importer = spec => JSON.stringify({ importers: { ".": { dependencies:
    spec ? { "@dxkjailbreak/sample": { specifier: spec } } : {} } } });
  fs.writeFileSync(lock, importer("file:../../plugins/dxkjailbreak/plugins/sample"));
  assert.equal(listInstalledProfiles(home).length, 1);
  assert.equal(dependenciesSynced([p]).ok, false);
  fs.copyFileSync(lock, actual);
  fs.writeFileSync(lock, importer());
  assert.equal(listInstalledProfiles(home).length, 1);
  assert.equal(dependenciesSynced([p]).ok, false);
  fs.writeFileSync(actual, importer());
  assert.equal(dependenciesSynced([p]).ok, true);
  fs.writeFileSync(lock, "broken: [");
  assert.equal(dependenciesSynced([p]).ok, false);
  fs.unlinkSync(p.pkgPath);
  assert.equal(dependenciesSynced([p]).ok, false);
});
