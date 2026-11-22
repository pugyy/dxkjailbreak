// dxkjailbreak · by dxk
// Registers the bundled `unrestricted` agent preset.
//
// DSH 0.1.7+ 的模式下拉只认 `agentPresets.register()`：把文件夹丢进
// `~/.dsh/.agent-presets/` 不会出现在下拉里（红队预设早期也踩过这个坑）。
// 所以这里和 lib/redteam/index.js 一样，等 registry 就绪后软注册一次，
// 卸载时释放。
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPresetDefinition } from "./redteam/preset-composition.js";
import { UNRESTRICTED_PRESET, bundledPresetDir, userPresetDir, installPreset } from "./presets.js";
import { findDshHome } from "./core.js";
import { adaptListAgents, withLegacyChildIds, migratePresetDefinition, backupPresetMigration, registerPresetDefinitions } from "./preset-compat.js";

export const name = "dxkjailbreak-presets";
export const inject = [];

const RETRY_LIMIT = 40;

function presetDir() {
  // 用户改过就用磁盘上那份，否则用包内模板。
  try {
    const user = userPresetDir();
    if (existsSync(join(user, "agent.cordis.yml")) || existsSync(join(user, "preset.yml"))) return user;
  } catch {
    /* 没有 DSH_HOME 时退回包内 */
  }
  return bundledPresetDir(UNRESTRICTED_PRESET);
}

export function apply(ctx) {
  // 副作用标记：证明本插件在宿主里真的被 apply 了（排障用）
  try {
    writeFileSync(join(findDshHome(), "presets-plugin-applied.txt"),
      new Date().toISOString() + "\n", "utf8");
  } catch { /* ignore */ }
  let release;
  const declaredReleases = [];
  let stopped = false;
  let tries = 0;

  const registry = () => {
    try {
      const fromProxy = ctx.agentPresets;
      if (fromProxy && typeof fromProxy.register === "function") return fromProxy;
    } catch {
      /* 未 inject 时读属性会抛 */
    }
    try {
      const fromGet = ctx.get?.("agentPresets");
      if (fromGet && typeof fromGet.register === "function") return fromGet;
    } catch {
      /* 服务还没起 */
    }
    return null;
  };

  const declare = async () => {
    if (stopped) return;
    const reg = registry();
    if (!reg) {
      if (tries++ < RETRY_LIMIT) setTimeout(declare, 500);
      return;
    }
    try {
      try { installPreset({ force: false }); }
      catch (error) { ctx.logger?.warn?.("dxkjailbreak-presets: %s", error.message); }
      const dir = presetDir();
      const definition = adaptListAgents(readPresetDefinition(UNRESTRICTED_PRESET, dir), ctx.get?.("profileContext")?.installAnchor);
      const migrated = migratePresetDefinition(definition, { stableChildIds: true });
      const backup = backupPresetMigration({ home: findDshHome(), dir, id: definition.id, policies: migrated.policies });
      release = await registerPresetDefinitions(reg, withLegacyChildIds(migrated, findDshHome()));

      if (stopped) { await release(); release = undefined; return; }
      ctx.logger?.info?.("dxkjailbreak-presets: 已注册预设 %s", definition.id);
      if (backup) ctx.logger?.info?.("dxkjailbreak-presets: 子任务策略已迁移；原始配置保持不变，备份 %s", backup);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      ctx.logger?.warn?.("dxkjailbreak-presets: 注册失败 %s", message);
      // 重复注册 / 定义非法属于终态，重试只会刷日志。
      if (/already|duplicate|invalid/i.test(message)) return;
      if (tries++ < RETRY_LIMIT) setTimeout(declare, 1000);
    }
  };

  declare();

  // 全量注册：把 .agent-presets 下其余 preset 也送进 registry。
  // 独立于 unrestricted 的注册：那边失败（例如 duplicate）也不连累这里。
  let allTries = 0;
  let allDone = false;
  const declareAll = async () => {
    if (stopped || allDone) return;
    const reg = registry();
    if (!reg) {
      // registry 服务在插件 apply 时往往还没就绪：必须重试，否则整段注册被跳过
      if (allTries++ < RETRY_LIMIT) setTimeout(declareAll, 500);
      return;
    }
    allDone = true;
    const report = [];
    try {
      const root = join(findDshHome(), ".agent-presets");
      const skip = new Set([UNRESTRICTED_PRESET, "redteam"]);
      for (const name of readdirSync(root)) {
        if (skip.has(name) || name.startsWith(".")) continue;
        const dir = join(root, name);
        if (!existsSync(join(dir, "preset.yml")) || !existsSync(join(dir, "agent.cordis.yml"))) continue;
        try {
          const def = adaptListAgents(readPresetDefinition(name, dir), ctx.get?.("profileContext")?.installAnchor);
          declaredReleases.push(await reg.register(def));
          report.push({ id: name, ok: true });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          report.push({ id: name, ok: /duplicate/i.test(message), note: message.slice(0, 200) });
          ctx.logger?.warn?.("dxkjailbreak-presets: %s 注册失败 %s", name, message);
        }
      }
    } catch (error) {
      report.push({ id: "<scan>", ok: false, note: error && error.message ? error.message : String(error) });
    }
    let listed = null;
    try {
      listed = (await reg.list()).map((p) => ({ id: p.id, name: p.name, order: p.order, broken: p.broken || null }));
    } catch (error) {
      listed = [{ id: "<list-failed>", name: String(error && error.message ? error.message : error) }];
    }
    try {
      writeFileSync(join(findDshHome(), "dxkjailbreak-presets-declare.json"),
        JSON.stringify({ at: new Date().toISOString(), total: report.length, report, registry: listed }, null, 2), "utf8");
    } catch { /* ignore */ }
    ctx.logger?.info?.("dxkjailbreak-presets: 全量注册处理 %d 个", report.length);
  };

  declareAll();


  ctx.effect(() => async () => {
    stopped = true;
    for (const off of declaredReleases.splice(0)) {
      try {
        await off?.();
      } catch {
        /* ignore */
      }
    }
    try {
      await release?.();
    } catch {
      /* ignore */
    }
  }, "dxkjailbreak-presets.registration");
}
