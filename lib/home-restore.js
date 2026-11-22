import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicFiles } from "./atomic-files.js";

const { atomicWriteSync } = atomicFiles(fs);
const managedFiles = ["AGENTS.md", "prompt-inject.md"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function optionalJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function validateStamp(stamp) {
  if (typeof stamp !== "string" || !/^\d{14}(?:-[A-Za-z0-9]+)?$/.test(stamp)) {
    throw new Error("无法识别 home 备份编号，已保留当前文件。");
  }
}

export function baselineBelongsToProfile(home, profile) {
  const state = path.join(home, "dxkjailbreak");
  const baseline = optionalJson(path.join(state, "baseline.json"));
  if (!baseline || baseline.retired) return false;
  validateStamp(baseline.stamp);
  const manifest = optionalJson(path.join(state, "backups", baseline.stamp, "manifest.json"));
  return manifest?.profile === profile;
}

export function beginHomeInstall(stateDir, backup) {
  const file = path.join(stateDir, "baseline.json");
  const previous = optionalJson(file);
  if (previous && !previous.retired) {
    validateStamp(previous.stamp);
    return previous.stamp;
  }
  const stamp = path.basename(backup);
  validateStamp(stamp);
  atomicWriteSync(file, JSON.stringify({ stamp, dir: backup, created: new Date().toISOString() }) + "\n");
  return stamp;
}

export function recordHomeWrites(stateDir, stamp, values) {
  const hashes = Object.fromEntries(managedFiles.map(name => [name, digest(values[name])]));
  atomicWriteSync(path.join(stateDir, "home-writes.json"), JSON.stringify({ stamp, hashes }) + "\n");
}

export function restoreOwnedHome(home, log = () => {}) {
  const result = { removed: [], restored: [], notices: [] };
  const notice = message => { result.notices.push(message); log(message); };
  const state = path.join(home, "dxkjailbreak");
  const file = path.join(state, "baseline.json");
  const baseline = optionalJson(file);
  if (!baseline || baseline.retired) return result;
  validateStamp(baseline.stamp);
  const writes = optionalJson(path.join(state, "home-writes.json"));
  if (writes?.stamp !== baseline.stamp) {
    notice("缺少本轮写入指纹，保留现有 home 文件。原始备份编号：" + baseline.stamp);
  } else {
    const dir = path.join(state, "backups", baseline.stamp);
    const manifest = optionalJson(path.join(dir, "manifest.json"));
    if (manifest?.stamp !== baseline.stamp) throw new Error("home 基线清单缺失或不匹配。");
    const changes = [];
    for (const name of managedFiles) {
      const target = path.join(home, name);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || digest(fs.readFileSync(target)) !== writes.hashes?.[name]) {
        notice("保留安装后发生变更的文件：" + target);
        continue;
      }
      const source = manifest.files?.[name];
      if (source === "absent") {
        changes.push({ target, name, bytes: null });
      } else {
        const backup = path.join(dir, name);
        if (typeof source !== "string" || path.basename(source) !== name || !fs.lstatSync(backup).isFile()) {
          throw new Error("home 备份无效，已保留当前文件：" + name);
        }
        changes.push({ target, name, bytes: fs.readFileSync(backup) });
      }
    }
    for (const { target, name, bytes } of changes) {
      if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isFile() ||
          digest(fs.readFileSync(target)) !== writes.hashes[name]) {
        notice("保留恢复期间发生变更的文件：" + target);
        continue;
      }
      if (bytes === null) {
        fs.unlinkSync(target);
        result.removed.push(target);
      } else {
        atomicWriteSync(target, bytes);
        result.restored.push(target);
      }
    }
  }
  atomicWriteSync(file, JSON.stringify({ ...baseline, retired: true }) + "\n");
  return result;
}
