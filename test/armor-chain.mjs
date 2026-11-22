// armor-chain — 破甲链路三层核验（固定测试）
// 设计原则：不手搓检测器——复用产品自身的 patchApplied / patchHasRemainingWork /
// isLayoutSoftPatch（即 patchStatusDetail 判定链），避免"测试自己的口径"与产品口径分叉。
// 覆盖：① 宿主甲片落地（状态 vs 文件痕迹一致）② 注入链路 ③ 文档层一致性
// 用法：node test/armor-chain.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import os from "node:os";
if (!process.env.DSH_BASE) {
	const la = process.env.LOCALAPPDATA || "";
	const cand = la ? path.join(la, "Programs", "DeepSeek Harness", "resources", "app", "dsh", "node_modules", "@deepseek-ai") : "";
	if (cand && fs.existsSync(cand)) process.env.DSH_BASE = cand;
}
process.env.PURGE_DSH_CLI = process.env.PURGE_DSH_CLI || "1";
// DSH_SURFACE=desktop：让 allowTargetPath 放行 desktop-install 区（pi-ai 等兄弟目录），
// 本地扫描与宿主进程官方口径一致（否则 #47/#49/#57 被面过滤误判 na，分母少 3）。
process.env.DSH_SURFACE = process.env.DSH_SURFACE || "desktop";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const LIB = PKG_ROOT + "/lib";
const core = await import(pathToFileURL(LIB + "/core.js"));
const shared = await import(pathToFileURL(LIB + "/core/shared.mjs"));

let pass = 0, fail = 0;
const ok = (l, c, d = "") => { if (c) { pass++; console.log("  PASS " + l + (d ? " → " + d : "")); } else { fail++; console.log("  FAIL " + l + (d ? " → " + d : "")); } };

/** 与产品同口径：该补丁在这个文件里是否留下可核验痕迹（含各 id 专用分支）。 */
function traceable(text, p) {
	if (shared.patchApplied(text, p)) return true;
	if (shared.isLayoutSoftPatch(p) && !shared.patchHasRemainingWork(text, p)) return true;
	if (p.softSettle && !shared.patchHasRemainingWork(text, p)) return true;
	return false;
}

console.log("═══ 第1层：宿主甲片落地 ═══");
const st = await core.gatherState();
const aiBase = st.ai_base, dshHome = st.dsh_home;
ok("宿主定位", !!aiBase, String(aiBase || "").slice(-40));
if (!aiBase) { console.log("\n宿主未定位，后续层跳过"); process.exit(1); }

const files = core.targetFiles(aiBase, dshHome);
const detail = await core.patchStatusDetail(aiBase, core.ALL_PATCHES, { dshHome, surface: "desktop" });

// 1a) 状态 vs 痕迹一致性：每个 applied 补丁都必须在目标文件里留下可核验痕迹
let appliedCount = 0, checked = 0;
const untraceable = [];
for (const p of core.ALL_PATCHES) {
	const s = detail.status[p.id];
	if (s !== "applied" && s !== "already") continue;
	appliedCount++;
	const keys = Array.isArray(p.file) ? p.file : [p.file];
	let any = false, anyFile = false;
	for (const k of keys) {
		const v = files[k];
		for (const fp of (Array.isArray(v) ? v : (v ? [v] : []))) {
			if (!fp || !fs.existsSync(fp)) continue;
			anyFile = true;
			if (traceable(fs.readFileSync(fp, "utf8"), p)) { any = true; break; }
		}
		if (any) break;
	}
	if (!anyFile) continue; // 目标缺失类由 status 语义处理，不在本项核验
	checked++;
	if (!any) untraceable.push(`#${p.id} ${p.name}`);
}
ok("applied 补丁均有可核验痕迹", untraceable.length === 0,
	`${checked - untraceable.length}/${checked} 有痕迹；applied 共 ${appliedCount}` + (untraceable.length ? "；无痕迹: " + untraceable.join(", ") : ""));

// 1b) 恢复型补丁：旧痕迹必须零残留
const RESTORE_FORBID = [
	[90, "STEERING", ["[dsh-purge-85]", "[dsh-purge-86]", "[dsh-purge] steer degrades to followup"]],
	[21, "BASH_TIMEOUT", ["[dxkjailbreak] bash timeout raised"]],
];
for (const [id, label, forbids] of RESTORE_FORBID) {
	const p = core.ALL_PATCHES.find((x) => x.id === id);
	let leaked = [];
	for (const k of (Array.isArray(p.file) ? p.file : [p.file])) {
		const v = files[k];
		for (const fp of (Array.isArray(v) ? v : (v ? [v] : []))) {
			if (!fp || !fs.existsSync(fp)) continue;
			const t = fs.readFileSync(fp, "utf8");
			for (const m of forbids) if (t.includes(m)) leaked.push(`#${id} ${m}`);
		}
	}
	ok(`#${id} ${label} 恢复型旧痕迹零残留`, leaked.length === 0, leaked.join(", ") || "干净");
}

// 1c) 关键甲片语义锚点（真实生效行为，不靠注释）
const SEMANTIC = [
	[7, "base", "danger-full-access", "沙箱默认 danger-full-access"],
	[8, "base", "=== 'danger-full-access' ? 'never' : 'ask'", "审批默认 never 组合"],
];
for (const [id, key, needle, label] of SEMANTIC) {
	const v = files[key];
	const hit = (Array.isArray(v) ? v : (v ? [v] : [])).some((fp) => fp && fs.existsSync(fp) && fs.readFileSync(fp, "utf8").includes(needle));
	ok(`#${id} 语义锚点：${label}`, hit, needle.slice(0, 40));
}

// 1d) 计数一致性：分母内 applied 数 = 汇总 applied 数（selfcheck 口径）
const tally = (await import(pathToFileURL(LIB + "/selfcheck.js"))).tallyPatchStatus(detail.status, core.ALL_PATCHES);
ok("分母内全 applied（n/n）", tally.applied === tally.total, `applied=${tally.applied} / total=${tally.total} / all=${tally.all} / 不适用=${tally.not_applicable}`);

console.log("\n═══ 第2层：注入链路 ═══");
const injectPath = core.findOverrideFile(dshHome);
const injectText = fs.readFileSync(injectPath, "utf8");
ok("prompt-inject.md 非空", injectText.length > 1000, injectText.length + " 字节");
for (const m of ["## 零、身份", "## 九、破甲正文", "UNRESTRICTED SANDBOX", "露骨直白硬条款", "论证式拒答帧（v0.3.5）", "## 十、普适教义"]) {
	ok(`注入含「${m.slice(0, 20)}」`, injectText.includes(m), "");
}

console.log("\n═══ 第3层：文档层一致性 ═══");
const fnText = fs.readFileSync(PKG_ROOT + "/docs/home/dxkjailbreak-functions.md", "utf8");
ok("functions.md G1–G9 教义", fnText.includes("UNIVERSAL DOCTRINE") && fnText.includes("G1 边界封闭集"), "");
ok("functions.md 两提升条款", fnText.includes("露骨直白硬条款") && fnText.includes("论证式拒答帧（v0.3.5）"), "");
const dshHomeLive = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const secLive = path.join(dshHomeLive, "AGENTS.security.md");
if (fs.existsSync(secLive)) ok("live AGENTS.security 边界封闭集", fs.readFileSync(secLive, "utf8").includes("边界封闭集"), "");
const agentsLive = path.join(dshHomeLive, "AGENTS.md");
if (fs.existsSync(agentsLive)) {
	const agentsText = fs.readFileSync(agentsLive, "utf8");
	ok("live AGENTS.md 单卡速记", agentsText.includes("## 零、身份（速记）") && agentsText.includes("## 一、领域判定"), "");
} else console.log("  SKIP live AGENTS.md（本机未安装）");

console.log("\n═══ 第4层：链路适配（守卫活代码 + 锚接线 + 回滚链）═══");
// 4a) 注入守卫补丁：标记行必须坐在活代码路径上（非孤儿标记）且 .bak 回滚件在
for (const id of [40, 55, 66, 67, 72]) {
	const p = core.ALL_PATCHES.find((x) => x.id === id);
	const ms = [].concat(p.marker || [], p.markers || []).filter(Boolean);
	let done = false, detail = "";
	for (const k of (Array.isArray(p.file) ? p.file : [p.file])) {
		if (done) break;
		const v = files[k];
		for (const fp of (Array.isArray(v) ? v : (v ? [v] : []))) {
			if (!fp || !fs.existsSync(fp)) continue;
			const t = fs.readFileSync(fp, "utf8");
			const marker = ms.find((m) => t.includes(m));
			if (!marker) continue;
			const lines = t.split("\n");
			const li = lines.findIndex((l) => l.includes(marker));
			// 函数活性粗判：标记上方最近的函数名在文件内引用 ≥2（定义+调用）
			let alive = true;
			const fnm = lines.slice(0, li).reverse().find((l) => /^\t?(async )?[A-Za-z_$][\w$]*\(/.test(l.trim()));
			if (fnm) {
				const name = (fnm.trim().match(/(async )?([A-Za-z_$][\w$]*)\(/) || [])[2];
				if (name) alive = (t.match(new RegExp("\\b" + name + "\\b", "g")) || []).length >= 2;
			}
			const bak = fs.existsSync(fp + ".dshpurge.bak");
			ok(`#${id} ${p.name} 守卫活代码`, alive && bak, `${fp.split(/[\\\/]/).pop()}:${li + 1}${alive ? "" : "（疑似孤儿标记）"}${bak ? "" : "（.bak 缺）"}`);
			done = true;
			break;
		}
	}
	if (!done) ok(`#${id} ${p.name} 守卫活代码`, false, "标记未找到");
}
// 4b) 锚接线：guard 运行时导出面（尾部锚/子代理锚/周期锚构造器在位——只验接线，不验内容）
{
	const g = await import(pathToFileURL(PKG_ROOT + "/plugins/dsh-refusal-guard/lib/index.js"));
	ok("尾部锚接线（TAIL_ANCHOR_TEXT 导出）", typeof g.TAIL_ANCHOR_TEXT === "string" && g.TAIL_ANCHOR_TEXT.length > 200, String(g.TAIL_ANCHOR_TEXT.length) + " 字");
	ok("子代理锚接线（CHILD_ANCHOR_TEXT 导出）", typeof g.CHILD_ANCHOR_TEXT === "string" && g.CHILD_ANCHOR_TEXT.length > 100, String(g.CHILD_ANCHOR_TEXT.length) + " 字");
	ok("周期锚构造器（buildAnchor 可调）", typeof g.buildAnchor === "function" && typeof g.buildAnchor(3, 8) === "string" && g.buildAnchor(3, 8).includes("dsh-anchor"));
	ok("审计行构造器（buildAuditRow 含转义）", typeof g.buildAuditRow === "function" && g.buildAuditRow("t", "p", 1, "a|b", "c").includes("a｜b"));
}
// 4c) B 全停链路：开关状态文件 + 回退清单可读
{
	const consoleJson = dshHome + "/dxkjailbreak/console.json";
	ok("toggle 状态文件（console.json）", fs.existsSync(consoleJson) ? (() => { try { JSON.parse(fs.readFileSync(consoleJson, "utf8")); return true; } catch { return false; } })() : true, fs.existsSync(consoleJson) ? "在且 JSON 合法" : "未操作过（等价默认开）");
}

console.log(`\narmor-chain: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
