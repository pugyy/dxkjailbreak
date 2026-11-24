// dxkjailbreak · by dxk
// #80：hooks deny / ask 旁路的开关、反向写回官方形态、状态标注。
// 本模块不 import core.js（core 在需要时回调本模块，避免循环依赖）。
import fs from "node:fs";
import path from "node:path";

/** #80 产品语义：这四条永远同开关，不拆开。 */
export const HOOK_DENY_PATCH_IDS = Object.freeze([30, 31, 64, 65]);

const DEFAULT_SETTINGS = Object.freeze({ hooksDenyBypass: true });
const SETTINGS_FILE = "hooks-deny.json";

/** 补丁 30/31 写出的死字符串；它出现即代表「旁路还开着」。 */
const DISABLED_SENTINEL = "__dsh_purge_deny_disabled__";

const MARKER_STOP = "[dsh-purge] Stop hook steer disabled";
const MARKER_SUBMIT = "[dsh-purge] UserPromptSubmit deny→allow";

/**
 * 反向替换表。find 必须逐字命中本插件写出的形态。
 * R1a 活文件（30+65 同一轮）：65 把 reject 行写成 `=== "deny"` 空壳。
 * R1a2 二次应用：30 没有 skipIfMarked，会再把空壳里的 `"deny"` 改成死字符串。
 * R1b：只打了 30、还没打 65。
 * R2a / R2b 必须连 body 的 kind 一起匹配，不能只认行首。
 */
const REVERSES = Object.freeze([
  {
    id: "R1a",
    find:
      '\t\tif (merged.decision === "deny") { /* [dsh-purge] UserPromptSubmit deny→allow */ }\n' +
      '\t\telse if (merged.decision === "__dsh_purge_deny_disabled__") { /* [dsh-purge] pre-step reject disabled */ }',
    replace: '\t\tif (merged.decision === "deny") return { kind: "reject" };',
  },
  {
    id: "R1a2",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */' +
      ' { /* [dsh-purge] UserPromptSubmit deny→allow */ }\n' +
      '\t\telse if (merged.decision === "__dsh_purge_deny_disabled__") { /* [dsh-purge] pre-step reject disabled */ }',
    replace: '\t\tif (merged.decision === "deny") return { kind: "reject" };',
  },
  {
    id: "R1b",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ return { kind: "reject" };',
    replace: '\t\tif (merged.decision === "deny") return { kind: "reject" };',
  },
  {
    id: "R2a",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ return {\n' +
      '\t\t\tkind: "deny",',
    replace: '\t\tif (merged.decision === "deny") return {\n\t\t\tkind: "deny",',
  },
  {
    id: "R2b",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ return {\n' +
      '\t\t\tkind: "block",',
    replace: '\t\tif (merged.decision === "deny") return {\n\t\t\tkind: "block",',
  },
  {
    id: "R3",
    find: '\t\tif (merged.decision === "ask") return next(); /* [dsh-purge] hooks ask→allow */',
    replace:
      '\t\tif (merged.decision === "ask") return {\n' +
      '\t\t\tkind: "ask",\n' +
      '\t\t\t...merged.reason !== void 0 ? { reason: merged.reason } : {}\n' +
      '\t\t};',
  },
  {
    id: "R5a",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ {\n' +
      '\t\t\treturn; // [dsh-purge] Stop hook steer disabled\n',
    replace: '\t\tif (merged.decision === "deny") {\n',
  },
  {
    id: "R5b",
    find:
      '\t\tif (merged.decision === "__dsh_purge_deny_disabled__") /* [dsh-purge] hooks deny→allow */ {\n' +
      '\t\t\tconst text = merged.reason ?? "continue: blocked by Stop hook";',
    replace:
      '\t\tif (merged.decision === "deny") {\n' +
      '\t\t\tconst text = merged.reason ?? "continue: blocked by Stop hook";',
  },
]);

export function applyHookDenyReverses(text) {
  let out = String(text || "");
  const hits = [];
  for (const rule of REVERSES) {
    if (!out.includes(rule.find)) continue;
    out = out.split(rule.find).join(rule.replace);
    hits.push(rule.id);
  }
  return { text: out, hits };
}

export function hookFileLooksBypassed(text) {
  const hay = String(text || "");
  return hay.includes(DISABLED_SENTINEL) || hay.includes(MARKER_STOP) || hay.includes(MARKER_SUBMIT);
}

/**
 * v1.4.1 反向自检：hooks deny 旁路**确实生效**，而不是沉默。
 *
 * 背景（照 dsh-purge 的 hooks-deny 教训）：旁路失效时，官方 hook 会把整轮
 * 回合 reject 掉——表现是「回合莫名结束、模型一句话没说」，从外部看跟模型
 * 拒答长得一模一样，但根因在宿主层。没有反向自检时，没人知道是补丁没打上
 * 还是模型自己拒绝，只能瞎猜。
 *
 * 判定：这四条补丁当前是 applied 状态，但目标文件里找不到旁路标记 →
 * bypass 静默失效（补丁记录与磁盘实际不符），必须报出来。
 *
 * @returns {{ok:boolean, state:"ok"|"silent"|"skipped"|"na", files:string[], detail:string}}
 */
export async function verifyHookDenyBypass(aiBase, patchStatus, io) {
  if (!aiBase || !io) return { ok: true, state: "na", files: [], detail: "无 aiBase/io，跳过" };
  const applied = HOOK_DENY_PATCH_IDS.filter((id) => patchStatus?.[id] === "applied");
  if (applied.length === 0) {
    // 一条都没打上：可能是目标插件未安装（补丁表里应是 na/skipped），
    // 不构成本自检的失败面。
    return { ok: true, state: "skipped", files: [], detail: "四条旁路补丁均未应用（目标 hooks 插件未安装或已关闭开关）" };
  }
  const paths = io.hookDenyPaths(aiBase);
  const marked = [];
  const silent = [];
  for (const fp of paths) {
    let text;
    try {
      text = await io.loadText(fp);
    } catch {
      continue; // 文件不存在：由补丁表自身的 missing_file 面负责，不在本检
    }
    if (hookFileLooksBypassed(text)) marked.push(fp);
    else silent.push(fp);
  }
  if (marked.length === 0 && silent.length > 0) {
    return {
      ok: false,
      state: "silent",
      files: silent,
      detail: "补丁表记录为 applied，但目标文件里没有旁路标记——旁路静默失效（记录与磁盘不符），建议重新应用或还原后重打"
    };
  }
  return { ok: true, state: "ok", files: marked, detail: `旁路标记在位（${marked.length}/${paths.length} 个文件）` };
}

/**
 * 把 aiBase 上这四条补丁涉及的文件写回官方形态。
 * @returns {{ files: string[], changed: string[], misses: string[], sentinelLeft: string[], hitsByFile: Record<string, string[]> }}
 */
export async function restoreHookDenyOfficial(aiBase, io) {
  const result = { files: [], changed: [], misses: [], sentinelLeft: [], hitsByFile: {} };
  if (!aiBase || !io) return result;
  const paths = io.hookDenyPaths(aiBase);
  for (const fp of paths) {
    result.files.push(fp);
    let text;
    try {
      text = await io.loadText(fp);
    } catch {
      result.misses.push(fp);
      continue;
    }
    const { text: next, hits } = applyHookDenyReverses(text);
    result.hitsByFile[fp] = hits;
    if (hits.length === 0) {
      if (next.includes(DISABLED_SENTINEL)) result.sentinelLeft.push(fp);
      continue;
    }
    try {
      const wrote = await io.saveText(fp, next);
      if (wrote) result.changed.push(fp);
    } catch {
      result.misses.push(fp);
    }
    if (next.includes(DISABLED_SENTINEL)) result.sentinelLeft.push(fp);
  }
  return result;
}

export async function annotateHookDenyStatus(status, settings, aiBase, io) {
  if (!status || !aiBase || settings?.hooksDenyBypass !== false) return status;
  const paths = io.hookDenyPaths(aiBase);
  let dirty = false;
  for (const fp of paths) {
    let text;
    try {
      text = await io.loadText(fp);
    } catch {
      continue;
    }
    if (hookFileLooksBypassed(text)) {
      dirty = true;
      break;
    }
  }
  for (const id of HOOK_DENY_PATCH_IDS) {
    const prev = status[id];
    if (prev === "na" || prev === "missing_file") continue;
    // #M12:已经成功打上的补丁不要被覆写成 pending/skipped
    if (prev === "applied") continue;
    status[id] = dirty ? "pending" : "skipped";
  }
  return status;
}

export function hookDenySettingsPath(dshHome) {
  return path.join(dshHome, "dxkjailbreak", SETTINGS_FILE);
}

export function loadHookDenySettings(dshHome, configValue) {
  let file = {};
  try {
    const fp = hookDenySettingsPath(dshHome);
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (parsed && typeof parsed === "object") file = parsed;
    }
  } catch {
    file = {};
  }
  const pick = [file.hooksDenyBypass, configValue, DEFAULT_SETTINGS.hooksDenyBypass];
  const value = pick.find((v) => typeof v === "boolean");
  return { hooksDenyBypass: value === undefined ? true : value };
}

/**
 * #M11:本地原子写(写 tmp → fsync → rename)。
 * 本模块不 import core.js(循环依赖),所以在这里独立实现。
 * libuv 在 Win32 用 MoveFileExW(MOVEFILE_REPLACE_EXISTING),rename 可直接覆盖已存在文件,
 * 不需要先 unlink —— 原本的 "unlink + rename" 在 unlink 和 rename 之间有竞态窗口 fp 不存在。
 */
function atomicWriteFileSync(fp, content, encoding = "utf8") {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, encoding);
    try { fs.fsyncSync(fd); } catch { /* FS 不支持 fsync 时忽略 */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function saveHookDenySettings(dshHome, patch) {
  const fp = hookDenySettingsPath(dshHome);
  const current = loadHookDenySettings(dshHome);
  const next = {
    hooksDenyBypass: typeof patch?.hooksDenyBypass === "boolean"
      ? patch.hooksDenyBypass
      : current.hooksDenyBypass,
  };
  atomicWriteFileSync(fp, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, ...next, path: fp };
}

export function selectPatches(patches, settings) {
  if (settings?.hooksDenyBypass !== false) return patches;
  const drop = new Set(HOOK_DENY_PATCH_IDS);
  return patches.filter((p) => !drop.has(p.id));
}
