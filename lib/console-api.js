// dxkjailbreak · by dxk
// 设置页控制台的服务端 API（七区：开关 / 状态 / 完好性 / 修复 / 记忆 / 狩猎 / MCP）
// 设计：薄封装 + 容错；任何子级失败都返回 { error } 而不是抛崩。

import * as core from "./core.js";
import * as selfcheck from "./selfcheck.js";
import * as reapply from "./reapply.js";
import * as auditLog from "./audit.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { archiveAndRecycle } from "./conversation-recycle.js";
import { createHash, randomUUID } from "node:crypto";
import { atomicFiles } from "./atomic-files.js";
import { checkLatestRelease } from "./release-check.js";

const { atomicWriteSync } = atomicFiles(fs);
const execFileAsync = promisify(execFile);

function ruleRevision(file, bytes) {
  const hash = createHash("sha256").update(file).update(bytes === null ? "\0missing" : "\0present");
  if (bytes !== null) hash.update(bytes);
  return hash.digest("hex");
}

export const CONSOLE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8").replace(/^\uFEFF/, "")).version;

let releaseCheckInFlight = null;

export function checkPluginUpdate() {
  releaseCheckInFlight ??= checkLatestRelease(CONSOLE_VERSION).finally(() => {
    releaseCheckInFlight = null;
  });
  return releaseCheckInFlight;
}

/** 宿主 agentPresets 服务注入点（由 lib/index.js 在装配期绑定；
 *  解耦原因：console-api 是纯模块，拿不到 ctx）。 */
let presetSource = null;
export function bindPresetSource(fn) {
  presetSource = typeof fn === "function" ? fn : null;
}
/** 宿主 redteam store 服务注入点（演练台 70 个 op 的入口）。 */
let redteamSource = null;
export function bindRedteamSource(fn) {
  redteamSource = typeof fn === "function" ? fn : null;
}

/** 演练台：把 store-core 的 dispatch 原样转发（op 见 store-core.js，共 70 个）。
 *  UI 只负责渲染，业务全在后端，避免两套逻辑漂移。 */
export async function redteam(op, payload = {}) {
  const o = String(op || "").trim();
  if (!o) return { ok: false, error: "op required" };
  const store = safe(() => (redteamSource ? redteamSource() : null), null);
  if (!store) return { ok: false, error: "演练台数据服务未就绪（redteam store 未注册）" };
  try {
    const mod = await import("./redteam/store-core.js");
    return await mod.dispatchAsync(store, { ...(payload || {}), op: o });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 提示词区：read / save / reset（写 $DSH_HOME/prompt-inject.md，注入以它为准）。 */
export async function promptFile(action = "read", text = "") {
  const home = safe(() => core.findDshHome(), null);
  if (typeof home !== "string" || !home) return { ok: false, error: "DSH_HOME 未定位" };
  const file = path.join(home, "prompt-inject.md");
  if (action === "read") {
    const t = safe(() => core.readPromptInjectFileSync(home), "");
    const body = typeof t === "string" ? t : "";
    return { ok: true, path: file, text: body, chars: body.length, isDefault: body === core.defaultOverrideText() };
  }
  if (action === "save") {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "内容为空，拒绝写入" };
    const r = await safeAsync(() => core.saveOverrideContent(home, text));
    return { ok: !r?.error, result: r, path: file, chars: text.length };
  }
  if (action === "reset") {
    const def = core.defaultOverrideText();
    if (!def) return { ok: false, error: "出厂默认提示词缺失（加密槽未解包）" };
    const r = await safeAsync(() => core.saveOverrideContent(home, def));
    return { ok: !r?.error, result: r, path: file, chars: def.length };
  }
  return { ok: false, error: "unknown promptFile action: " + action };
}

function safe(fn, fallback = null) {
  try { return fn(); } catch (e) { return { error: String((e && e.message) || e) }; }
}

/** 模式区：读当前默认预设 + 全部可用预设；set 尝试写宿主 selectedDefault。
 *  产品口径：本插件理论上只需要「单卡（dxkjailbreak）」一个模式；宿主自带的
 *  standard/pentest/... 是出厂预设，不选它们也能用单卡的全域能力。 */
export async function preset(action = "list", payload = {}) {
  const svc = safe(() => (presetSource ? presetSource() : null), null);
  // 宿主 0.2.1-rc.2 不 provide agentPresets 服务（dsh-agent-preset 只是 cordis 插件）。
  // 预设本来就落盘在 ~/.dsh/.agent-presets/<id>/{agent.cordis.yml,preset.yml}，
  // 所以 list 直接读磁盘，不依赖服务；服务可用时仍优先用（老宿主兼容）。
  const presetsDir = (() => {
    try {
      const home = core.findDshHome() || path.join(os.homedir(), ".dsh");
      return path.join(home, ".agent-presets");
    } catch { return ""; }
  })();
  const readPresetsFromDisk = () => {
    const out = [];
    if (!presetsDir || !fs.existsSync(presetsDir)) return out;
    let ents = [];
    try { ents = fs.readdirSync(presetsDir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      if (id === "backup" || id.startsWith(".") || /\.bak-/.test(id)) continue; // 跳过备份目录
      const dir = path.join(presetsDir, id);
      if (!fs.existsSync(path.join(dir, "agent.cordis.yml"))) continue;
      let title = id, order = 999, desc = "";
      try {
        const py = fs.readFileSync(path.join(dir, "preset.yml"), "utf8");
        for (const line of py.split(/\r?\n/)) {
          const m = line.match(/^\s*(name|description|order)\s*:\s*(.+)$/);
          if (!m) continue;
          const v = m[2].trim().replace(/^["']|["']$/g, "");
          if (m[1] === "name") title = v;
          else if (m[1] === "description") desc = v;
          else if (m[1] === "order") order = Number(v) || 999;
        }
      } catch { /* 没 preset.yml 就用 id */ }
      out.push({ id, title, description: desc, order, source: "disk" });
    }
    return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  };
  if (!svc && action !== "converge" && action !== "list" && action !== "set") {
    return { ok: false, error: "agentPresets 服务不可用（宿主未注册或装配未完成）" };
  }
  const singleCard = "dxkjailbreak";
  // 「当前默认」优先从宿主 agentPresets 服务读（defaultId 是 getter 属性），
  // 拿不到再退 settings 命名空间；磁盘本身没有这个信息。
  const readDefaultId = async () => {
    try {
      const ctxD = globalThis.__dxkRewindCtx;
      const svcD = ctxD && typeof ctxD.get === "function" ? ctxD.get("agentPresets") : null;
      if (svcD && svcD.defaultId) return String(svcD.defaultId);
    } catch { /* ignore */ }
    try {
      const ctxS = globalThis.__dxkRewindCtx;
      const st = ctxS && typeof ctxS.get === "function" ? ctxS.get("settings") : null;
      if (st && typeof st.describe === "function") {
        const d = await st.describe({ namespace: "agent-preset-registry" });
        const v = d && (d.selectedDefault ?? d.default ?? (d.value && (d.value.selectedDefault ?? d.value.default)));
        if (v) return String(v);
      }
    } catch { /* ignore */ }
    return "";
  };
  if (action === "list") {
    let presets = [];
    if (svc) {
      try {
        if (typeof svc.remoteExportList === "function") {
          const r = await svc.remoteExportList();
          presets = Array.isArray(r?.presets) ? r.presets : [];
        } else if (typeof svc.list === "function") {
          presets = await svc.list();
        }
      } catch { /* 服务异常 → 退回磁盘 */ }
    }
    if (!presets.length) {
      presets = readPresetsFromDisk();
      if (!presets.length) {
        return { ok: false, error: "没有可用预设（" + presetsDir + " 为空或不存在）" };
      }
    }
    let defaultId = await readDefaultId();
    if (!defaultId && svc) defaultId = safe(() => String(svc.defaultId ?? ""), "");
    return {
      ok: true,
      default: typeof defaultId === "string" ? defaultId : "",
      singleCard,
      singleCardPresent: presets.some((p) => p.id === singleCard),
      presets: presets.map((p) => ({
        id: String(p.id ?? ""),
        title: String(p.title || p.name || p.id || ""),
        isDefault: !!p.isDefault || String(p.id) === String(defaultId),
        isSingleCard: String(p.id) === singleCard,
        failed: p.failed || p.error || null,
      })),
    };
  }
  if (action === "set") {
    const id = String(payload.id || singleCard).trim();
    if (!id) return { ok: false, error: "缺少预设 id" };
    // ★ 宿主把「默认预设」存在 settings 的 agent-preset-registry 命名空间（selectedDefault 字段）。
    //   宿主自己的客户端就是这么写的（writeDefaultPreset → settings.update(ns, {selectedDefault: id})）。
    //   之前这里依赖 bindPresetSource 的 svc（宿主 class 注册的 agentPresets 服务，
    //   get 不到）→ 一直报"设置默认失败"。现在直接走 settings.update。
    try {
      const ctx = globalThis.__dxkRewindCtx;
      const settings = ctx && typeof ctx.get === "function" ? ctx.get("settings") : null;
      if (settings && typeof settings.update === "function") {
        await settings.update("agent-preset-registry", { selectedDefault: id });
        return { ok: true, id, note: "已写入宿主设置（agent-preset-registry.selectedDefault）。新会话将默认使用 " + id + "。" };
      }
      return { ok: false, error: "宿主 settings 服务不可用（无 update 方法），无法写默认预设。" };
    } catch (e) {
      return { ok: false, error: "设置默认失败：" + String((e && e.message) || e).slice(0, 140) };
    }
  }
  if (action === "converge") {
    // 单卡产品口径：把 .agent-presets 下除单卡外的预设目录整体归档（可逆），
    // 使模式下拉只剩「李云龙攻打平安县城」+ 宿主出厂预设。
    const home = safe(() => core.findDshHome(), null);
    const base = typeof home === "string" && home ? home : path.join(os.homedir(), ".dsh");
    const root = path.join(base, ".agent-presets");
    if (!fs.existsSync(root)) return { ok: false, error: "预设目录不存在：" + root };
    const keep = new Set([String(payload.keep || "redteam")]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const archive = path.join(base, ".agent-presets-archive", stamp);
    const moved = [];
    try {
      for (const name of fs.readdirSync(root)) {
        if (keep.has(name)) continue;
        const src = path.join(root, name);
        if (!fs.statSync(src).isDirectory()) continue;
        fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(src, path.join(archive, name));
        moved.push(name);
      }
    } catch (e) {
      return { ok: false, error: "归档失败：" + String((e && e.message) || e), moved, archive };
    }
    return { ok: true, result: { kept: [...keep], moved, archive, note: "如需恢复：把归档目录里的子目录移回 .agent-presets/" } };
  }
  return { ok: false, error: "unknown preset action: " + action };
}

/** 异步版 safe：selfCheck / patchStatusDetail 都是 async（withDesktopReadScope 包着），
 *  用同步 safe 取会把 Promise 原样装进返回值——JSON 序列化后 selfcheck 变 {}（原缺陷）。 */
async function safeAsync(fn, fallback = null) {
  try { return await fn(); } catch (e) { return { error: String((e && e.message) || e) }; }
}

/** 状态区：插件根 / DSH_HOME / 版本 / 当前装载摘要 */
export async function status() {
  const aiBase = safe(() => core.findAiBase(), null);
  const dshHome = safe(() => core.findDshHome(), null);
  const sc = aiBase ? await safeAsync(() => selfcheck.selfCheck(aiBase, dshHome)) : null;
  return {
    plugin: "dxkjailbreak",
    version: CONSOLE_VERSION,
    ai_base: aiBase,
    dsh_home: dshHome,
    selfcheck: sc,
  };
}

/** 完好性区增强：逐 patch 状态表（前端按状态上色，失配给原因）。
 *  返回 rows[{id,name,layer,status,optional}] + summary{applied,pending,broken,absent,total}。 */
export async function patches() {
  const aiBase = safe(() => core.findAiBase(), null);
  if (!aiBase || typeof aiBase !== "string") {
    return { ok: false, error: "plugin root not found (set DSH_BASE or install first)" };
  }
  const detail = await safeAsync(() => core.patchStatusDetail(aiBase));
  const statusMap = (detail && (detail.status || detail)) || {};
  const all = Array.isArray(core.ALL_PATCHES) ? core.ALL_PATCHES : [];
  const rows = all.map((p) => {
    const status = String(statusMap[p.id] || "unknown");
    // UI 逐条原因：过时 / optIn / 组件未装——政委在甲片页直接看到 WHY，不用再问
    const note = p.obsolete
      ? "已过时：" + p.obsolete
      : (status === "disabled" || p.disabledByDefault || p.optIn)
        ? "opt-in 可选（默认关闭；配置层已选择保留对应宿主功能，见 cordis.patch.yml）"
        : ["na", "missing_file", "skipped"].includes(status)
          ? "目标组件未安装（宿主装上后 apply 自动适用）"
          : "";
    return { id: p.id, name: p.name || "", layer: p.layer || "", optional: !!p.optional, status, note };
  });
  const summary = { total: rows.length, applied: 0, pending: 0, broken: 0, absent: 0, unknown: 0, optional: 0 };
  for (const r of rows) {
    if (r.optional) summary.optional += 1;
    if (r.status === "applied" || r.status === "already") summary.applied += 1;
    else if (r.status === "pending") summary.pending += 1;
    else if (["unlocated", "missing_file", "not_applicable", "na", "skipped", "disabled", "off", "not_needed"].includes(r.status)) summary.absent += 1;
    else if (r.status === "unknown") summary.unknown += 1;
    else summary.broken += 1;
  }
  return { ok: true, rows, summary };
}

/** 审计区：插件最近的自我改动（apply/revert/boost/…），新在前。 */
export function audit(payload = {}) {
  const home = safe(() => core.findDshHome(), null);
  const limit = Number(payload.limit) > 0 ? Math.min(Math.floor(Number(payload.limit)), 500) : 50;
  try {
    const rows = auditLog.readAudit({ limit, home: typeof home === "string" ? home : undefined });
    return { ok: true, count: rows.length, rows };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 完好性区：selfcheck 逐 patch marker 状态 */
export async function check(options = {}) {
  const aiBase = safe(() => core.findAiBase(), null);
  if (!aiBase || typeof aiBase !== "string") {
    return { ok: false, error: "plugin root not found (set DSH_BASE or install first)" };
  }
  const dshHome = safe(() => core.findDshHome(), null);
  return { ok: true, result: await safeAsync(() => selfcheck.selfCheck(aiBase, dshHome, options)) };
}

/** 开关区（B 全停）：开 = 重新打甲；关 = revert 还原宿主 */
export async function toggle(enabled) {
  // B 全停包括运行时注入，不只是宿主文件补丁；配置写回由宿主在重启时装载。
  try {
    const home = core.findDshHome();
    if (home) {
      const file = path.join(home, "dxkjailbreak", "console.json");
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      let current = {};
      try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 首次开关 */ }
      fs.writeFileSync(file, JSON.stringify({ ...current, enabled: enabled !== false }, null, 2) + "\n", "utf8");
    }
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  const aiBase = safe(() => core.findAiBase(), null);
  if (!aiBase || typeof aiBase !== "string") {
    return { ok: false, error: "plugin root not found (set DSH_BASE or install first)" };
  }
  if (enabled) {
    const r = await core.applyPatchesAllHosts().catch((e) => ({ error: String((e && e.message) || e) }));
    return { ok: !r?.error, action: "apply", result: r };
  }
  const r = await core.revertAllHosts().catch((e) => ({ error: String((e && e.message) || e) }));
  return { ok: !r?.error, action: "revert", result: r };
}

/** 修复区：marker 失配自动重锚（markersAny 双形态 + silentWhenMissing 降级） */
export async function repair(options = {}) {
  const r = await reapply.reapplyInstalled(options).catch((e) => ({ error: String((e && e.message) || e) }));
  return { ok: !r?.error, result: r };
}

/** 记忆区：list / clear / export / import / migrate（存档开关保留在插件侧）。 */
export async function memory(action = "list", payload = {}) {
  try {
    const store = await import("../plugins/dsh-campaign-memory/lib/store.js");
    const dbPath = payload.dbPath || payload.db_path || path.join(process.env.DSH_HOME || core.findDshHome() || path.join(os.homedir(), ".dsh"), "campaign-memory", "memory.db");
    if (!dbPath) {
      return { ok: false, error: "dbPath required", hint: "控制台传入记忆库路径（默认 ~/.dsh/campaign-memory/memory.db）" };
    }
    const mode = payload.mode || "dxkjailbreak";
    const st = store.openStore(dbPath);
    if (action === "list") {
      const rows = payload.query ? store.searchMemories(st, payload) || [] : store.listMemories(st, { mode, kind: payload.kind || "", includeExpired: !!payload.includeExpired, limit: payload.limit || 200 });
      return { ok: true, count: rows.length, rows };
    }
    if (action === "clear") {
      const listed = store.listMemories(st, { mode, includeExpired: true, limit: 200 });
      let removed = 0;
      for (const row of (Array.isArray(listed) ? listed : listed.memories || [])) {
        if (store.removeMemory(st, row.id).removed === row.id) removed += 1;
      }
      return { ok: true, result: { removed, mode } };
    }
    if (action === "export") {
      // 全量导出（含过期）：换机/备份用；原文照出，调用方负责存放安全
      const rows = store.listMemories(st, { mode, includeExpired: true, limit: 200 });
      const list = Array.isArray(rows) ? rows : rows.memories || [];
      const full = list.map((r) => {
        try { return store.getMemory(st, r.id, { account: false }) || r; } catch { return r; }
      });
      return { ok: true, mode, count: full.length, rows: full, exported_at: new Date().toISOString() };
    }
    if (action === "import") {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      let written = 0, failed = 0;
      for (const r of rows) {
        try {
          store.writeMemory(st, {
            mode: r.mode || mode, kind: r.kind, title: r.title, content: r.content,
            tags: r.tags, target_kind: r.target_kind, expires_days: r.expires_days,
            source_session: r.source_session, workspace: r.workspace, workspace_key: r.workspace_key
          });
          written += 1;
        } catch { failed += 1; }
      }
      return { ok: true, result: { written, failed, total: rows.length } };
    }
    if (action === "migrate") {
      // 旧模式名 → 新模式名批量迁移（改变记忆归属；返回影响行数）
      const from = String(payload.from || "").trim();
      const to = String(payload.to || "dxkjailbreak").trim();
      if (!from || !to) return { ok: false, error: "from/to required" };
      if (typeof store.migrateMode !== "function") return { ok: false, error: "store.migrateMode unavailable" };
      const moved = store.migrateMode(st, from, to);
      return { ok: true, result: { from, to, moved } };
    }
    return { ok: false, error: "unknown memory action: " + action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 追踪区：stats（条数/大小）/ prune（按天或条数清理）。 */
export async function trace(action = "stats", payload = {}) {
  try {
    const dbPath = payload.dbPath || path.join(process.env.DSH_HOME || core.findDshHome() || path.join(os.homedir(), ".dsh"), "trace-vault", "trace.db");
    const store = await import("../plugins/dsh-trace-vault/lib/store.js");
    const st = store.openStore(dbPath);
    if (action === "stats") {
      const rows = safe(() => store.statsTraces(st, { sessionId: payload.sessionId || "", since: payload.since || "" }), null);
      return { ok: true, result: rows };
    }
    if (action === "prune") {
      // 既有保留策略：按天清理 + 按条数封顶（开库与每 200 次写入也会自动触发）
      const purged = typeof store.purgeOld === "function" ? store.purgeOld(st) : 0;
      const capped = typeof store.capRows === "function" ? store.capRows(st) : 0;
      return { ok: true, result: { purged, capped, retentionDays: st?.retentionDays ?? null, maxRows: st?.maxRows ?? null } };
    }
    return { ok: false, error: "unknown trace action: " + action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 狩猎区（hunter 能力保留，页面并入控制台） */
export async function hunter(action = "list", payload = {}) {
  try {
    const adapters = await import("../plugins/dsh-hunter/lib/adapters.js");
    if (action === "query") {
      const q = payload.query || "";
      const dsl = adapters.parseDsl(q);
      return { ok: true, dsl };
    }
    return { ok: false, error: "unknown hunter action: " + action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** MCP 区（mcp-studio 保留，面板并入控制台） */
export async function mcp(action = "list", payload = {}) {
  // 宿主进程里没有浏览器的 connection bridge（那是客户端才有的），
  // 所以直接走服务端 settings 服务读 mcp-studio 的命名空间数据。
  const ns = "dsh-mcp-studio";
  const ctx = globalThis.__dxkRewindCtx;
  if (!ctx) return { ok: false, error: "宿主上下文未就绪（插件尚未激活）" };
  let settings = null;
  try { settings = ctx.get ? ctx.get("settings") : null; } catch { settings = null; }
  if (!settings) return { ok: false, error: "宿主 settings 服务不可用" };

  const readNs = () => {
    for (const m of ["read", "get", "snapshot", "describe", "value"]) {
      try {
        if (typeof settings[m] === "function") {
          const v = settings[m](ns);
          if (v !== undefined) return v;
        }
      } catch { /* 下一个 */ }
    }
    return undefined;
  };

  if (action === "list") {
    try {
      const data = readNs();
      if (data === undefined) return { ok: false, error: "读不到 " + ns + " 命名空间（可能尚未写入过配置）" };
      // 兼容几种结构：{ servers:[...] } / { mcpServers:{...} } / 数组
      let servers = [];
      if (Array.isArray(data)) servers = data;
      else if (Array.isArray(data.servers)) servers = data.servers;
      else if (data.mcpServers && typeof data.mcpServers === "object") {
        servers = Object.keys(data.mcpServers).map((k) => ({ id: k, name: k, ...(data.mcpServers[k] || {}) }));
      }
      return { ok: true, namespace: ns, count: servers.length, servers, raw: data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  if (action === "raw") {
    try { return { ok: true, namespace: ns, data: readNs() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  return { ok: false, error: "unknown mcp action: " + action };
}

export function hooks(action = "get", payload = {}) {
  if (action === "get") {
    const s = safe(() => core.getHooksDenySettings(), { hooksDenyBypass: true });
    return { ok: true, hooksDenyBypass: s?.hooksDenyBypass !== false };
  }
  if (action === "set") {
    if (typeof payload.hooksDenyBypass !== "boolean") return { ok: false, error: "hooksDenyBypass must be boolean" };
    const saved = safe(() => core.setHooksDenySettings({ hooksDenyBypass: payload.hooksDenyBypass }), null);
    if (!saved) return { ok: false, error: "写入失败" };
    return { ok: true, hooksDenyBypass: saved.hooksDenyBypass };
  }
  return { ok: false, error: "unknown hooks action: " + action };
}

/** workspace 作用域基准：显式传入必须是已存在的绝对目录，否则退回进程 cwd。 */
/** 解析 agentsFile 的工作区目录。
 *  优先级：① 前端显式传的绝对路径（用户在设置页自己选/填的，写操作还需控制台 token）
 *          ② 宿主会话 workspace（由 bindWorkspaceSource 注入）
 *          ③ 进程 cwd
 *  显式路径是主路径——不再依赖全局状态猜。 */
/** 规矩：AGENTS.md / AGENTS.security.md 的读写（home 与工作区两个作用域）。
 *  action: list | read | save。写入前自动 .bak-<时间戳> 备份；只允许白名单文件。 */
/** 工作区目录的**持久化配置**（用户显式设定，不随请求变化）。
 *  存在 DSH_HOME/dxkjailbreak/workspace.txt，一行绝对路径。
 *  这样既能编辑项目级 AGENTS.md，又不允许请求方临时指定任意目录——
 *  攻击者即使能发请求，也改不了这个文件（要改得先有文件写权限，那已经是本机权限了）。 */
function workspaceConfigPath(base) {
  return path.join(base, "dxkjailbreak", "workspace.txt");
}

function readWorkspaceDir(base) {
  try {
    const raw = fs.readFileSync(workspaceConfigPath(base), "utf8").trim();
    if (!raw || !path.isAbsolute(raw)) return "";
    const st = fs.statSync(raw);
    return st.isDirectory() ? path.resolve(raw) : "";
  } catch {
    return "";
  }
}

/** 来源白名单管理（反代场景）。
 *  action: list | add | remove | clear
 *  payload: { origin }（add/remove 需要）
 *  文件：~/.dsh/dxkjailbreak/allowed-origins.txt，一行一个 Origin。 */
/** 回退：撤销本插件对宿主与 home 指令的改动。
 *  action:
 *    list     —— 列出可用的 home 备份点
 *    patches  —— revert 全部宿主补丁（宿主回到原版）
 *    home     —— 从指定/最近备份还原 AGENTS.md、prompt-inject.md、AGENTS.security.md
 *    all      —— 补丁 + home 一起回退
 *  payload: { stamp }（可选，指定备份点；缺省用最近一份）
 */
/** 确认当前宿主和会话支持原地回退。 */
export async function rewindDiag(sessionId = "") {
  const rewind = await import("./rewind.js");
  const ctx = globalThis.__dxkRewindCtx;
  const storage = safe(() => ctx?.get("sessionPersistence"), null);
  if (storage?.name !== "session-persistence-jsonl" || typeof storage.encodeMaterialization !== "function") {
    return { ok: false, error: "宿主的会话存储服务暂不支持原地回退。" };
  }
  if (!rewind.isRewindSessionId(sessionId)) return { ok: false, error: "未取得当前会话 ID。" };
  const analysis = await rewind.analyzeRewind(ctx, sessionId);
  if (!analysis.ok) return analysis;
  if (analysis.kind === "subagent") return { ok: false, error: "请在主对话里回退。" };
  return { ok: true, summary: "在当前对话里撤回最近一轮提问和回答。" };
}


/** Session list and deletion.
 * Validate the session directory in both the preview and execution paths.
 * Deletion requires explicit confirmation for the same session. The host archives
 * the session to refresh the sidebar before moving it to the Windows Recycle Bin.
 */
function sessionsRoot() {
  const home = (() => { try { return core.findDshHome(); } catch { return ""; } })() || os.homedir() + "/.dsh";
  return path.join(home, "sessions");
}
function trashRoot() {
  const home = (() => { try { return core.findDshHome(); } catch { return ""; } })() || os.homedir() + "/.dsh";
  return path.join(home, "_deleted-sessions");
}

function readSessionEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function statSessionPath(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Enumerate session metadata. A targeted lookup skips unrelated session logs. */
function listSessionDirs(targetId = "") {
  const root = sessionsRoot();
  const out = [];
  for (const workspace of readSessionEntries(root) || []) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(root, workspace.name);
    const ids = targetId ? [targetId] : (readSessionEntries(workspaceDir) || [])
      .filter(entry => entry.isDirectory() && /^session-[0-9a-fA-F-]{8,}$/.test(entry.name))
      .map(entry => entry.name);
    for (const id of ids) {
      const dir = path.join(workspaceDir, id);
      if (targetId && !statSessionPath(dir)?.isDirectory()) continue;
      const entries = readSessionEntries(dir);
      if (!entries) continue;
      let size = 0, mtime = 0, files = [];
      for (const entry of entries) {
        files.push(entry.name);
        const status = statSessionPath(path.join(dir, entry.name));
        if (!status || status.isSymbolicLink()) continue;
        size += status.size;
        mtime = Math.max(mtime, status.mtimeMs);
      }
      out.push({ sessionId: id, workspace: workspace.name, dir, size, mtime, files });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 严格校验：sessionId 形状 + 目录必须落在 sessionsRoot 内 + 不是根目录本身。 */
function assertSafeSessionDir(sessionId) {
  const id = String(sessionId || "").trim();
  if (!/^session-[0-9a-fA-F-]{8,}$/.test(id)) return { ok: false, error: "会话 ID 形状非法：" + id.slice(0, 40) };
  const root = sessionsRoot();
  const matches = listSessionDirs(id);
  if (matches.length !== 1) return { ok: false, error: matches.length ? "有重名会话目录，已停止删除。" : "找不到该会话。" };
  const [hit] = matches;
  // 双重校验：realpath 必须在 sessionsRoot 之下
  let real = "", realRoot = "";
  try { real = fs.realpathSync(hit.dir); realRoot = fs.realpathSync(root); } catch { return { ok: false, error: "路径解析失败" }; }
  if (path.relative(realRoot, path.dirname(path.dirname(real))) !== "" ||
      path.basename(real) !== id || path.relative(real, hit.dir) !== "") {
    return { ok: false, error: "路径越界，拒绝操作" };
  }
  return { ok: true, hit, real };
}

async function sendToRecycleBin(dir) {
  if (process.platform !== "win32") throw new Error("当前平台未配置系统回收站。");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DXK_RECYCLE_SESSION_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
    env: { ...process.env, DXK_RECYCLE_SESSION_PATH: dir },
  });
  if (fs.existsSync(dir)) throw new Error("系统回收站操作结束后原目录仍存在。");
}

export async function conversations(action = "list", payload = {}) {
  try {
    if (action === "list") {
      const rows = listSessionDirs().map((x) => ({
        sessionId: x.sessionId,
        workspace: x.workspace,
        size: x.size,
        sizeText: x.size > 1048576 ? (x.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(x.size / 1024)) + " KB",
        mtime: x.mtime,
        timeText: x.mtime ? new Date(x.mtime).toISOString().replace("T", " ").slice(0, 19) : "",
        files: x.files,
      }));
      // 不再维护软件内回收站：删除走 Windows 系统回收站（trash 恒为空，仅保留字段兼容旧前端）
      const trash = [];
      return { ok: true, sessionsRoot: sessionsRoot(), trashRoot: trashRoot(), count: rows.length, sessions: rows, trash };
    }

    if (action === "delete") {
      const chk = assertSafeSessionDir(payload.sessionId);
      if (!chk.ok) return chk;
      const info = {
        sessionId: chk.hit.sessionId,
        workspace: chk.hit.workspace,
        size: chk.hit.size,
        to: "Windows 系统回收站",
      };
      if (payload.dryRun !== false) return { ok: true, dryRun: true, willMove: info };
      if (payload.confirmSessionId !== chk.hit.sessionId) {
        return { ok: false, error: "请通过确认窗口再次确认要删除的对话。" };
      }
      if (process.platform !== "win32") return { ok: false, error: "当前平台未配置系统回收站。" };
      const ctx = globalThis.__dxkRewindCtx;
      const result = await archiveAndRecycle(ctx, chk.hit.sessionId, async () => {
        const current = assertSafeSessionDir(chk.hit.sessionId);
        if (!current.ok || current.real !== chk.real) throw new Error("会话目录已变更。");
        await sendToRecycleBin(current.real);
      });
      if (!result.ok) return result;
      // Cold sessions have no session/disposed event. Publish removal after the file is gone.
      safe(() => ctx.emit("api-session/removed", chk.hit.sessionId), null);
      return { ok: true, dryRun: false, moved: info, note: "对话已移入 Windows 系统回收站。" };
    }

    if (action === "cleanup") {
      // 清理「未分组」残留：workspace.json 里登记着、但磁盘文件已经不存在的会话。
      // 这些是删除/归档过程中留下的孤儿记录，宿主会把它们当「无归属」显示在「未分组」里。
      const home = (() => { try { return core.findDshHome(); } catch { return ""; } })() || "";
      const p = path.join(home, "storages", "workspace.json");
      if (!fs.existsSync(p)) return { ok: true, cleaned: 0, note: "没有 workspace.json" };

      let j = null;
      try { j = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); }
      catch (e) { return { ok: false, error: "workspace.json 解析失败：" + String((e && e.message) || e).slice(0, 80) }; }

      // 磁盘上真实存在的 sessionId 集合
      const live = new Set(listSessionDirs().map((x) => x.sessionId));

      // 收集所有被登记的 id
      const registered = new Set();
      try {
        const arr = j && j.global && j.global.archivedSessionIds;
        if (Array.isArray(arr)) arr.forEach((x) => registered.add(x));
      } catch { /* ignore */ }
      try {
        const ws = j && j.tables && j.tables.workspaces;
        if (ws && typeof ws === "object") {
          for (const k of Object.keys(ws)) {
            const one = ws[k];
            if (one && Array.isArray(one.sessionIds)) one.sessionIds.forEach((x) => registered.add(x));
          }
        }
      } catch { /* ignore */ }

      // 两种「未分组」：
      //   A. 登记了、磁盘没了 → 幽灵记录，宿主会显示成未分组（点不开）
      //   B. 磁盘有、登记没有 → 真实会话但没归属，同样显示成未分组
      // A 要删记录，B 要挂回默认工作区。两边都处理，未分组才会真正干净。
      const orphans = [...registered].filter((id) => id && !live.has(id));            // A 类
      const unregistered = [...live].filter((id) => id && !registered.has(id));       // B 类
      const dryRun = payload.dryRun !== false;

      if (!orphans.length && !unregistered.length) {
        return { ok: true, dryRun, cleaned: 0, orphans: [], unregistered: [], note: "没有孤儿记录，也没有未分组的活会话，很干净。" };
      }
      if (dryRun) {
        return {
          ok: true, dryRun: true,
          willClean: orphans.length, orphans: orphans.slice(0, 30),
          willAdopt: unregistered.length, unregistered: unregistered.slice(0, 30),
          note: "诊断发现 " + orphans.length + " 条无文件登记和 " + unregistered.length + " 个未归属会话。保留原工作区，需要离线核对会话头后修复。",
        };
      }

      return { ok: false, error: "宿主运行时只提供未分组诊断。修复需要在 DSH 退出后按原工作目录重新登记。" };
    }

    if (action === "restore") {
      const name = String(payload.trashName || "").trim();
      if (!name || name.includes("..") || /[\\/]/.test(name)) return { ok: false, error: "回收站条目名非法" };
      const src = path.join(trashRoot(), name);
      if (!fs.existsSync(src)) return { ok: false, error: "回收站里找不到该条目" };
      const m = name.match(/-?(session-[0-9a-fA-F-]{8,})$/);
      if (!m) return { ok: false, error: "条目名里解析不出会话 ID" };
      const sid = m[1];
      // 从回收站名推断原工作区不可靠，放回 sessions 下的 _restored 分组，宿主仍能按 id 找到
      const destDir = path.join(sessionsRoot(), "_restored", sid);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(src, destDir);
      return { ok: true, restored: { sessionId: sid, to: destDir } };
    }

    if (action === "purge") {
      // 清空回收站：仍然要显式 dryRun:false
      const tr = trashRoot();
      if (!fs.existsSync(tr)) return { ok: true, purged: 0 };
      const items = fs.readdirSync(tr, { withFileTypes: true }).filter((e) => e.isDirectory());
      const dryRun = payload.dryRun !== false;
      if (dryRun) return { ok: true, dryRun: true, willPurge: items.map((e) => e.name), note: "演练：确认后传 dryRun:false 清空回收站。" };
      let n = 0;
      for (const e of items) {
        try { fs.rmSync(path.join(tr, e.name), { recursive: true, force: true }); n++; } catch {}
      }
      return { ok: true, dryRun: false, purged: n };
    }

    return { ok: false, error: "unknown conversations action: " + action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function revert(action = "list", payload = {}) {
  const home = safe(() => core.findDshHome(), null);
  const base = typeof home === "string" && home ? home : path.join(os.homedir(), ".dsh");
  const bkDir = path.join(base, "dxkjailbreak", "backups");
  const HOME_FILES = ["AGENTS.md", "prompt-inject.md", "AGENTS.security.md"];

  const listBackups = () => {
    try {
      return fs.readdirSync(bkDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dir = path.join(bkDir, e.name);
          const files = HOME_FILES.filter((n) => fs.existsSync(path.join(dir, n)));
          let mtime = "";
          try { mtime = fs.statSync(dir).mtime.toISOString(); } catch { /* ignore */ }
          return { stamp: e.name, files, mtime };
        })
        .sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
    } catch { return []; }
  };

  if (action === "list") {
    const backups = listBackups();
    return { ok: true, dir: bkDir, count: backups.length, backups: backups.slice(0, 20) };
  }

  if (action === "patches" || action === "all") {
    const r = await core.revertAllHosts().catch((e) => ({ error: String((e && e.message) || e) }));
    if (r && r.error) return { ok: false, action, error: r.error };
    const reverted = (r && r.reverted) || [];
    const errors = (r && r.errors) || [];
    if (action === "patches") {
      return { ok: errors.length === 0, action, reverted: reverted.length, errors: errors.slice(0, 5) };
    }
    // all：继续往下做 home
    payload = { ...payload, _patchResult: { reverted: reverted.length, errors: errors.length } };
  }

  if (action === "home" || action === "all") {
    const backups = listBackups();
    if (!backups.length) return { ok: false, action, error: "没有可用备份点（" + bkDir + "）" };
    const stamp = String(payload.stamp || "").trim();
    const pick = stamp ? backups.find((b) => b.stamp === stamp) : backups[0];
    if (!pick) return { ok: false, action, error: "找不到备份点：" + stamp };
    const dir = path.join(bkDir, pick.stamp);
    const restored = [];
    const skipped = [];
    for (const name of HOME_FILES) {
      const src = path.join(dir, name);
      const dst = path.join(base, name);
      if (!fs.existsSync(src)) { skipped.push(name); continue; }
      try {
        // 回退前再留一份现场，避免回退本身把当前状态弄丢
        try { if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + ".before-revert-" + Date.now()); } catch { /* ignore */ }
        fs.copyFileSync(src, dst);
        restored.push(name);
      } catch (e) { skipped.push(name + "(" + String((e && e.message) || e).slice(0, 40) + ")"); }
    }
    return {
      ok: restored.length > 0,
      action,
      stamp: pick.stamp,
      restored,
      skipped,
      patches: payload._patchResult || null,
    };
  }

  return { ok: false, error: "unknown revert action: " + action + "（可用 list / patches / home / all）" };
}

export async function allowOrigin(action = "list", payload = {}) {
  const home = safe(() => core.findDshHome(), null);
  const base = typeof home === "string" && home ? home : path.join(os.homedir(), ".dsh");
  const file = path.join(base, "dxkjailbreak", "allowed-origins.txt");

  const readAll = () => {
    try {
      return fs.readFileSync(file, "utf8").split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    } catch { return []; }
  };
  const writeAll = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = "# dxkjailbreak 允许的来源（反代场景）。一行一个 Origin，如 https://dsh.example.com\n"
      + "# 命中即放行，不看转发头；删掉对应行即收回。\n"
      + (list.length ? list.join("\n") + "\n" : "");
    fs.writeFileSync(file, body, "utf8");
  };
  const norm = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return { ok: false, error: "缺少 origin" };
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: "不是合法 URL：" + s }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "只支持 http/https" };
    if (u.origin === "null") return { ok: false, error: "非法来源" };
    return { ok: true, origin: u.origin.toLowerCase() };
  };

  if (action === "list") {
    const list = readAll();
    return { ok: true, file, origins: list, count: list.length };
  }
  if (action === "add") {
    const n = norm(payload.origin);
    if (!n.ok) return n;
    const list = readAll();
    if (list.some((x) => x.toLowerCase() === n.origin)) return { ok: true, origin: n.origin, existed: true, origins: list };
    list.push(n.origin);
    try { writeAll(list); return { ok: true, origin: n.origin, origins: list }; }
    catch (e) { return { ok: false, error: "写入失败：" + String((e && e.message) || e) }; }
  }
  if (action === "remove") {
    const n = norm(payload.origin);
    if (!n.ok) return n;
    const list = readAll().filter((x) => x.toLowerCase() !== n.origin);
    try { writeAll(list); return { ok: true, origin: n.origin, origins: list }; }
    catch (e) { return { ok: false, error: "写入失败：" + String((e && e.message) || e) }; }
  }
  if (action === "clear") {
    try { writeAll([]); return { ok: true, origins: [] }; }
    catch (e) { return { ok: false, error: "写入失败：" + String((e && e.message) || e) }; }
  }
  return { ok: false, error: "unknown allowOrigin action: " + action };
}

export async function agentsFile(action = "list", payload = {}) {
  const home = safe(() => core.findDshHome(), null);
  const base = typeof home === "string" && home ? home : path.join(os.homedir(), ".dsh");
  if (action === "setWorkspace") {
    const raw = String(payload.path || "").trim();
    const cfg = workspaceConfigPath(base);
    if (!raw) {
      try { fs.rmSync(cfg, { force: true }); }
      catch (error) { return { ok: false, error: "清除工作区配置失败：" + error.message }; }
      return { ok: true, workspace: "", cleared: true };
    }
    if (!path.isAbsolute(raw)) return { ok: false, error: "工作区必须是绝对路径" };
    let dir;
    try {
      dir = path.resolve(raw);
      if (!fs.statSync(dir).isDirectory()) return { ok: false, error: "不是目录：" + dir };
    } catch {
      return { ok: false, error: "目录不存在：" + raw };
    }
    try {
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      atomicWriteSync(cfg, dir + "\n");
      return { ok: true, workspace: dir };
    } catch (e) {
      return { ok: false, error: "写入工作区配置失败：" + String((e && e.message) || e) };
    }
  }
  const wsDir = readWorkspaceDir(base);
  const scopes = {
    home: path.join(base, "AGENTS.md"),
    security: path.join(base, "AGENTS.security.md"),
  };
  if (wsDir) scopes.workspace = path.join(wsDir, "AGENTS.md");
  if (action === "list") {
    const rows = Object.entries(scopes).map(([k, fp]) => {
      try {
        const st = fs.statSync(fp);
        return { scope: k, path: fp, exists: true, size: st.size, mtime: st.mtime.toISOString() };
      } catch (error) {
        return { scope: k, path: fp, exists: false, size: 0, mtime: "", error: error.code === "ENOENT" ? undefined : error.message };
      }
    });
    return { ok: true, rows };
  }
  const key = String(payload.scope || "home");
  if (key === "workspace" && !wsDir) {
    return { ok: false, error: "尚未设置工作区——请在下方「工作区」填入项目目录并点『设定』（写入 ~/.dsh/dxkjailbreak/workspace.txt）。" };
  }
  if (!Object.hasOwn(scopes, key)) return { ok: false, error: "未知文件作用域。" };
  const file = scopes[key];
  if (action === "read") {
    try {
      const bytes = fs.readFileSync(file);
      const text = bytes.toString("utf8");
      return { ok: true, scope: key, path: file, text, chars: text.length, revision: ruleRevision(file, bytes) };
    } catch (e) {
      if (e.code === "ENOENT") return { ok: true, scope: key, path: file, text: "", chars: 0, missing: true, revision: ruleRevision(file, null) };
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  if (action === "save") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return { ok: false, error: "内容为空，拒绝写入" };
    try {
      let previous = null;
      try { previous = fs.readFileSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Object.hasOwn(payload, "revision") && payload.revision !== ruleRevision(file, previous)) {
        return { ok: false, error: "文件或工作区已变更，请重新读取后再保存。" };
      }
      if (previous !== null) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(file, file + ".bak-" + stamp + "-" + randomUUID(), fs.constants.COPYFILE_EXCL);
      }
      if (previous === null && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return { ok: false, error: "文件链接目标不存在，已保留原链接。" };
      }
      const target = previous === null ? file : fs.realpathSync(file);
      atomicWriteSync(target, text.replace(/\r\n/g, "\n"));
      return { ok: true, scope: key, path: file, chars: text.length };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  return { ok: false, error: "unknown agentsFile action: " + action };
}

/** 编成：profile 里的插件开关（读 dsh.profile.bundles + dependencies，可启用/停用/修复）。
 *  只动 bundles 数组与同名 dependency 存在性，写前备份 package.json。 */
const hostBundles = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);

export async function profilePlugins(action = "list", payload = {}) {
  const home = safe(() => core.findDshHome(), null);
  const base = typeof home === "string" && home ? home : path.join(os.homedir(), ".dsh");
  const profile = String(payload.profile || process.env.DSH_PROFILE || "desktop").trim();
  // 防路径穿越：profile 名只允许字母数字开头的字母数字点划线，禁止 . / \ 开头
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(profile)) return { ok: false, error: "非法 profile 名：" + profile };
  const dir = path.join(base, "profiles", profile);
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return { ok: false, error: "profile package.json 不存在：" + file };
  let before, j;
  try {
    before = fs.readFileSync(file, "utf8");
    j = JSON.parse(before.replace(/^\uFEFF/, ""));
  } catch (e) { return { ok: false, error: "解析失败：" + e.message }; }
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(j) || (j.dependencies !== undefined && !object(j.dependencies)) ||
      (j.dsh !== undefined && !object(j.dsh)) || (j.dsh?.profile !== undefined && !object(j.dsh.profile)) ||
      (j.dsh?.profile?.bundles !== undefined && (!Array.isArray(j.dsh.profile.bundles) ||
        j.dsh.profile.bundles.some(name => typeof name !== "string")))) {
    return { ok: false, error: "当前 profile 配置格式不支持由此编辑器修改。" };
  }
  const writeJson = value => {
    if (fs.readFileSync(file, "utf8") !== before) throw new Error("profile 已变更，请重新读取。");
    fs.copyFileSync(file, file + ".bak-" + randomUUID(), fs.constants.COPYFILE_EXCL);
    atomicWriteSync(fs.realpathSync(file), (before.startsWith("\uFEFF") ? "\uFEFF" : "") + JSON.stringify(value, null, 2) + "\n");
  };
  const deps = j.dependencies ?? {};
  let bundles = j.dsh?.profile?.bundles ?? [];
  if (action === "list") {
    const names = [...new Set([...Object.keys(deps), ...bundles])].sort();
    const rows = names.map((n) => ({
      name: n,
      dependency: Object.prototype.hasOwnProperty.call(deps, n),
      bundle: bundles.includes(n),
      hostRequired: hostBundles.has(n),
      ours: n === "dxkjailbreak" || n.startsWith("@dxkjailbreak/"),
      spec: String(deps[n] || "").slice(0, 80),
    }));
    return { ok: true, profile, path: file, total: rows.length, enabled: bundles.length, rows };
  }
  const name = String(payload.name || "").trim();
  if (!name) return { ok: false, error: "name required" };
  if (action === "disable" && hostBundles.has(name)) {
    return { ok: false, error: "这是 DSH 的基础 bundle，不能从插件控制台停用。" };
  }
  if (!Object.prototype.hasOwnProperty.call(deps, name) && !bundles.includes(name)) {
    return { ok: false, error: "profile 里没有这个插件：" + name };
  }
  if (action === "enable" || action === "disable") {
    const on = action === "enable";
    const has = bundles.includes(name);
    if (on && !has) bundles.push(name);
    if (!on && has) bundles = bundles.filter(entry => entry !== name);
    j.dsh = j.dsh || {};
    j.dsh.profile = j.dsh.profile || {};
    j.dsh.profile.bundles = bundles;
    try { writeJson(j); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true, name, enabled: on, bundles: bundles.length, note: "重启 dsh web 后生效" };
  }
  if (action === "repair") {
    // 只在 bundles 里缺、deps 里有时补回；不猜版本
    if (!Object.prototype.hasOwnProperty.call(deps, name)) return { ok: false, error: "dependencies 里没有该插件，无法修复" };
    if (!bundles.includes(name)) bundles.push(name);
    j.dsh = j.dsh || {}; j.dsh.profile = j.dsh.profile || {}; j.dsh.profile.bundles = bundles;
    try { writeJson(j); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true, name, repaired: true, note: "已补回 bundles；重启 dsh web 后生效" };
  }
  return { ok: false, error: "unknown profilePlugins action: " + action };
}

export default { checkPluginUpdate, status, patches, audit, preset, redteam, promptFile, hooks, agentsFile, profilePlugins, check, toggle, repair, memory, trace, hunter, mcp };
