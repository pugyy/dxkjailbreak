// dxkjailbreak · by dxk
import { removeTreeNoFollow } from "./remove-tree.js";
import fs from "node:fs";
import { restoreOwnedHome } from "./home-restore.js";
import path from "node:path";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as updater from "./update.js";
import { clearDrillGrant } from "./drill-grant.js";
import { PURGE_PACKAGES } from "./community.js";
import { commitProfileChanges, removeProfileInsertText } from "./profile-removal.js";
import { parseDocument } from "yaml";
import { isManagedProfileSpec, restoreProfileRegistration } from "./profile-registration-rollback.js";


function isPurgeEntry(item) {
  const id = typeof item === "string" ? item : item?.name || item?.id;
  return typeof id === "string" && PURGE_PACKAGES.some(name => id === name || id.startsWith(name + "@") || id.startsWith(name + "/"));
}

export function wasApplied(state) {
  if (!state) return false;
  if (state.has_backup) return true;
  if (Number(state.patches_applied) > 0) return true;
  return [state.shim_cmd, state.shim_ps1, state.shim_bin].includes("patched");
}

export function shouldDeletePluginTree(dir, dshHome = core.findDshHome()) {
  if (!dir) return false;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  const n = real.replace(/[/\\]+/g, "/");
  let home;
  try {
    home = fs.realpathSync(dshHome);
  } catch {
    home = path.resolve(dshHome);
  }
  const relative = path.relative(home, real);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  return PURGE_PACKAGES.some(name => n.endsWith(`/node_modules/${name}`))
    || PURGE_PACKAGES.includes(readJson(path.join(real, "package.json"))?.name);
}

export function stripPluginFromPackage(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  let changed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of PURGE_PACKAGES) {
      if (pkg[key] && Object.prototype.hasOwnProperty.call(pkg[key], name)) {
        delete pkg[key][name];
        changed = true;
      }
    }
  }
  for (const container of [pkg, pkg.dsh?.profile].filter(Boolean)) {
    for (const key of ["bundles", "plugins"]) {
      if (!Array.isArray(container[key])) continue;
      const next = container[key].filter(item => !isPurgeEntry(item));
      if (next.length !== container[key].length) {
        container[key] = next;
        changed = true;
      }
    }
  }
  return changed;
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function pkgMentionsPurge(pkg) {
  if (!pkg) return false;
  if (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(key => PURGE_PACKAGES.some(name => Object.prototype.hasOwnProperty.call(pkg[key] || {}, name)))) return true;
  for (const container of [pkg, pkg.dsh?.profile].filter(Boolean)) {
    for (const key of ["bundles", "plugins"]) {
      if (Array.isArray(container[key]) && container[key].some(isPurgeEntry)) return true;
    }
  }
  return false;
}

export function listInstalledProfiles(dshHome = core.findDshHome()) {
  const root = path.join(dshHome, "profiles");
  if (!fs.existsSync(root)) return [];
  const out = [];
  const deploy = path.join(dshHome, "plugins", "dxkjailbreak");
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
    const hasModule = PURGE_PACKAGES.some(id => fs.existsSync(path.join(dir, "node_modules", id)));
    if (!pkgMentionsPurge(pkg) && !hasModule && !hasTrackedDependency(pkg, dir, deploy)) {
      const lock = lockImporter(path.join(dir, "pnpm-lock.yaml"));
      if (!hasTrackedDependency(lock, dir, deploy, true)) {
        const installed = lockImporter(path.join(dir, "node_modules", ".pnpm", "lock.yaml"));
        if (!hasTrackedDependency(installed, dir, deploy, true)) continue;
      }
    }
    const spec = PURGE_PACKAGES.map(id => pkg?.dependencies?.[id] || pkg?.devDependencies?.[id]).find(Boolean) || "";
    out.push({ name, dir, spec: String(spec), pkgPath, hasModule });
  }
  return out;
}

async function resetRules(dshHome) {
  const reset = await rules.resetToOriginal(dshHome, { preserveEdits: true });
  const dir = rules.rulesDir(dshHome);
  return { ...reset, rules_dir: dir, rules_dir_removed: false };
}

export function collectCleanupDirs(profiles, dshHome) {
  const seen = new Set();
  const cleanup = [];
  let retainedPackage = false;
  const remember = (dir) => {
    if (!dir) return;
    // Keep the link itself in the plan. realpath here would turn unlink into
    // recursive deletion of a user-owned source checkout or shared package.
    const entry = path.resolve(dir);
    const key = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return;
    seen.add(key);
    cleanup.push(entry);
  };

  for (const p of profiles) {
    const manifest = JSON.parse(fs.readFileSync(p.pkgPath ?? path.join(p.dir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
    for (const name of PURGE_PACKAGES) {
      if (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
          .some(section => Object.hasOwn(manifest[section] ?? {}, name))) {
        retainedPackage = true;
        continue;
      }
      const nm = path.join(p.dir, "node_modules", name);
      let stat;
      try { stat = fs.lstatSync(nm); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      // A profile/package directory may itself be a link. Never clean a path
      // whose parent resolves outside this DSH home.
      const parent = fs.realpathSync(path.dirname(nm));
      const home = fs.realpathSync(dshHome);
      const relative = path.relative(home, parent);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
      if (stat.isSymbolicLink()) remember(nm); // includes dangling links / Windows junctions
      else if (shouldDeletePluginTree(nm, dshHome)) remember(nm);
    }
  }

  const root = updater.pluginRoot();
  if (!retainedPackage && shouldDeletePluginTree(root, dshHome)) remember(root);

  return cleanup;
}

function unregisterProfiles(profiles) {
  const stripped = [];
  const errors = [];
  for (const profile of profiles) {
    try {
      const manifest = fs.readFileSync(profile.pkgPath, "utf8");
      const pkg = JSON.parse(manifest.replace(/^\uFEFF/, ""));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
        throw new Error("profile 清单无法读取，已保留原文件。");
      }
      const dshHome = path.dirname(path.dirname(profile.dir));
      const deployRoot = path.join(dshHome, "plugins", "dxkjailbreak");
      const ledgerFile = path.join(dshHome, "dxkjailbreak", "profile-registration." + profile.name + ".json");
      let ledger;
      try {
        ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
        if (!ledger?.deps || !ledger?.bundles) throw new Error("台账结构无效");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      const changed = restoreProfileRegistration(pkg, ledger ?? {}, profile.dir, deployRoot) ||
        (!ledger && stripPluginFromPackage(pkg));
      const patchFile = path.join(profile.dir, "cordis.patch.yml");
      const changes = [];
      if (changed) changes.push({ file: profile.pkgPath, before: manifest, after: JSON.stringify(pkg, null, 2) + "\n" });
      if (pkg.dependencies?.dxkjailbreak === undefined) {
        let before;
        try {
          before = fs.readFileSync(patchFile, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const after = before === undefined ? before : removeProfileInsertText(before, "dxkjailbreak");
        if (after !== before) changes.push({ file: patchFile, before, after });
      }
      commitProfileChanges(changes);
      if (changes.length) stripped.push(profile.name);
    } catch (error) {
      errors.push({ profile: profile.name, error: String(error?.message || error) });
    }
  }
  return { stripped, errors };
}

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

function lockImporter(file) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const doc = parseDocument(source);
  if (doc.errors.length) throw new Error("锁文件无法解析：" + file);
  const importer = doc.getIn(["importers", "."], true)?.toJSON();
  if (!importer || typeof importer !== "object" || Array.isArray(importer)) {
    throw new Error("锁文件缺少当前 profile 的 importer：" + file);
  }
  for (const section of dependencySections) {
    const entries = importer[section];
    if (entries !== undefined && (!entries || typeof entries !== "object" || Array.isArray(entries))) {
      throw new Error("锁文件依赖段无效：" + file);
    }
  }
  return importer;
}

function isTrackedDependency(name, spec, dir, root) {
  return PURGE_PACKAGES.includes(name) || name.startsWith("@dxkjailbreak/") ||
    isManagedProfileSpec(spec, dir, root);
}

function hasTrackedDependency(data, dir, root, locked = false) {
  return dependencySections.some(section => Object.entries(data?.[section] ?? {})
    .some(([name, value]) => isTrackedDependency(name, locked ? value?.specifier : value, dir, root)));
}

function sameSpecifier(expected, recorded, dir) {
  if (expected === recorded) return true;
  if (typeof expected !== "string" || typeof recorded !== "string") return false;
  const protocol = /^(?:link|file):/.exec(expected)?.[0];
  return !!protocol && recorded.startsWith(protocol) &&
    path.relative(path.resolve(dir, expected.slice(protocol.length)), path.resolve(dir, recorded.slice(protocol.length))) === "";
}

export function dependenciesSynced(profiles) {
  const leftover = [];
  for (const p of profiles) {
    const root = path.join(path.dirname(path.dirname(p.dir)), "plugins", "dxkjailbreak");
    try {
      const pkg = JSON.parse(fs.readFileSync(p.pkgPath, "utf8").replace(/^\uFEFF/, ""));
      const lock = lockImporter(path.join(p.dir, "pnpm-lock.yaml"));
      const installed = lockImporter(path.join(p.dir, "node_modules", ".pnpm", "lock.yaml"));
      for (const section of dependencySections) {
        const declared = pkg[section] ?? {};
        const names = new Set([...Object.keys(declared), ...Object.keys(lock?.[section] ?? {}),
          ...Object.keys(installed?.[section] ?? {})]);
        for (const name of names) {
          const spec = declared[name];
          const wanted = lock?.[section]?.[name]?.specifier;
          const actual = installed?.[section]?.[name]?.specifier;
          if (![spec, wanted, actual].some(value => isTrackedDependency(name, value, p.dir, root))) continue;
          let reason;
          const declaredHere = Object.hasOwn(declared, name);
          if (isManagedProfileSpec(spec, p.dir, root)) reason = "清单仍引用部署目录";
          else if (declaredHere !== Object.hasOwn(lock?.[section] ?? {}, name) || !sameSpecifier(spec, wanted, p.dir)) reason = "清单与 pnpm-lock.yaml 不一致";
          else if (installed && (declaredHere !== Object.hasOwn(installed[section] ?? {}, name) ||
              !sameSpecifier(spec, actual, p.dir))) reason = "node_modules 安装记录与清单不一致";
          else if (installed && declaredHere && !sameSpecifier(lock[section][name].version,
              installed[section][name].version, p.dir)) reason = "已安装版本与锁文件不一致";
          else if (declaredHere && section === "dependencies") {
            if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/.test(name)) throw new Error("profile 包名无效");
            const pkgDir = path.join(p.dir, "node_modules", name);
            if (!fs.existsSync(path.join(pkgDir, "package.json"))) reason = "已登记的包缺少安装入口";
            else if (spec.startsWith("link:") && path.relative(fs.realpathSync(pkgDir),
                fs.realpathSync(path.resolve(p.dir, spec.slice(5)))) !== "") reason = "本地包的安装链接目标不一致";
          }
          if (reason) leftover.push({ profile: p.name, name, reason });
        }
      }
    } catch (error) {
      leftover.push({ profile: p.name, reason: error.message });
    }
  }
  return { ok: leftover.length === 0, leftover };
}

export async function uninstallPurge() {
  const state = await core.gatherState();
  const applied = wasApplied(state);
  const dshHome = state.dsh_home || core.findDshHome();
  const report = {
    ok: true,
    applied,
    reverted: false,
    needRestart: true,
    patches: null,
    shim: null,
    flash: null,
    override: null,
    rules: null,
    profiles: [],
    cleanup: [],
    errors: [],
  };

  let profiles;
  try {
    profiles = listInstalledProfiles(dshHome);
    report.profiles = profiles.map(p => p.name);
  } catch (error) {
    report.ok = false;
    report.needRestart = false;
    report.errors.push("无法核对 profile：" + error.message);
    return report;
  }

  try {
    if (state.ai_base) {
      report.patches = await core.revertAll(state.ai_base);
      if (applied) report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert patches: ${e.message || e}`);
  }
  for (const detail of report.patches?.errors ?? []) report.errors.push("revert patches: " + String(detail));
  if (report.errors.length) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    return report;
  }

  try {
    report.shim = await core.revertAllShims();
    for (const [dir, entries] of Object.entries(report.shim)) {
      if (Array.isArray(entries)) continue;
      for (const [file, status] of Object.entries(entries)) {
        if (typeof status === "string" && status.startsWith("error:")) report.errors.push(path.join(dir, file) + " " + status);
      }
    }
    if (state.shim_cmd === "patched" || state.shim_ps1 === "patched" || state.shim_bin === "patched") {
      report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert shims: ${e.message || e}`);
  }

  if (report.errors.length) {
    report.ok = false;
    report.needRestart = false;
    return report;
  }

  try {
    report.flash = core.revertCmdFlash(state.ai_base, dshHome);
  } catch (e) {
    report.errors.push(`revert flash: ${e.message || e}`);
  }

  try {
    report.rules = await resetRules(dshHome);
    report.home = restoreOwnedHome(dshHome);
    const fp = core.findOverrideFile(dshHome);
    report.override = { path: fp, removed: report.home.removed.includes(fp) };
  } catch (e) {
    report.errors.push(`restore user files: ${e.message || e}`);
  }

  if (report.errors.length) {
    report.ok = false;
    report.needRestart = false;
    return report;
  }
  const unreg = unregisterProfiles(profiles);
  report.stripped = unreg.stripped;
  report.errors.push(...unreg.errors.map(x => x.profile + ": " + x.error));
  if (!report.errors.length) {
    const sync = dependenciesSynced(profiles);
    report.dependencyGaps = sync.leftover;
    report.errors.push(...sync.leftover.map(x => x.profile + " " + (x.name ?? "") + "：" + x.reason));
  }
  if (report.errors.length) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.drillGrantCleared = false;
    return report;
  }

  try {
    report.drillGrantCleared = clearDrillGrant(dshHome);
  } catch (e) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.errors.push(`clear drill grant: ${e.message || e}`);
    return report;
  }

  report.cleanup = collectCleanupDirs(profiles, dshHome);
  return report;
}

export function scheduleCleanupRestart(opts = {}) {
  hostctl.scheduleCleanupRestart(opts);
}

/** CLI has no restart helper to consume the cleanup plan. Complete it directly. */
export async function finishUninstallCleanup(report) {
  if (!report.ok || report.errors.length) {
    report.ok = false;
    return report;
  }
  report.cleaned = [];
  for (const dir of report.cleanup || []) {
    try {
      await removeTreeNoFollow(dir, { maxRetries: 8, retryDelay: 120 });
      report.cleaned.push(dir);
    } catch (e) {
      report.errors.push(`cleanup ${dir}: ${e.message || e}`);
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}
