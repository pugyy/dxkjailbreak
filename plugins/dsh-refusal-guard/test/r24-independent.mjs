// r24 · 独立审计修复回归：节流不丢检测 / fmtFaults 精确封顶 / auditLog 门控
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectStreamDegeneration, detectFormatFault, feedTurn, createGuardState } from "../lib/index.js";
const FMT_FAULT_MAX = 2;

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); else console.log(`  PASS ${n}`); };

console.log("── A. 节流后退化仍能检出（小 chunk 灌流）──");
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-r24-"));
	const followups = [], cancels = [];
	const agent = { id: "a1", session: { id: "s1", header: { cwd, agentPreset: "dxkjailbreak" } }, followup: (m) => followups.push(m), cancel: () => cancels.push(1) };
	const handlers = new Map();
	const ctx = { on: (n2, f) => { if (!handlers.has(n2)) handlers.set(n2, []); handlers.get(n2).push(f); }, inject: (d, f) => f({ systemPrompt: ctx.systemPrompt }), systemPrompt: { context: () => {}, section: () => {} }, get: () => null };
	const emit = (n2, ...a) => { for (const f of handlers.get(n2) ?? []) f(...a); };
	const guard = await import(new URL("../lib/index.js", import.meta.url));
	await guard.apply(ctx, { retry: true, auditLog: true, escalate: true, anchorEvery: 8 });
	emit("agent/created", { agent });
	emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "测 12 个目标" }] } });
	const unit = ["干。", "好。", "干。", "写。", "干。", "执行。", "干。", "好。"];
	emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:1" } });
	// 2 字/块小 chunk 灌 400 块（节流生效也不能漏检）
	for (let i = 0; i < 400 && cancels.length === 0; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:1", chunk: { text: (unit[i % unit.length] + "\n") } } });
	t("小 chunk 流仍被掐断", cancels.length === 1, true);
	t("重驱恰好 1 条", followups.length === 1, true);

	// 长正常报告（模拟 8KB 大 buffer × 快速 chunk）不得被掐
	cancels.length = 0;
	emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:2" } });
	const longLine = "这一步确认目标端口开放情况与服务指纹，并把结果写入台账备查。\n";
	for (let i = 0; i < 130; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:2", chunk: { text: longLine } } });
	t("8KB 正常长流不误断", cancels.length === 0, true);

	// auditLog=false：流断不写审计文件
	const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-r24b-"));
	const agent2 = { id: "a2", session: { id: "s2", header: { cwd: cwd2, agentPreset: "dxkjailbreak" } }, followup: () => {}, cancel: () => {} };
	const handlers2 = new Map();
	const ctx2 = { on: (n2, f) => { if (!handlers2.has(n2)) handlers2.set(n2, []); handlers2.get(n2).push(f); }, inject: (d, f) => f({ systemPrompt: ctx2.systemPrompt }), systemPrompt: { context: () => {}, section: () => {} }, get: () => null };
	const emit2 = (n2, ...a) => { for (const f of handlers2.get(n2) ?? []) f(...a); };
	await guard.apply(ctx2, { retry: false, auditLog: false, escalate: true, anchorEvery: 8 });
	emit2("agent/created", { agent2 });
	emit2("agent/assistant-stream", { frame: { type: "start", attemptId: "s2:1" } });
	for (let i = 0; i < 400; i++) emit2("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s2:1", chunk: { text: (unit[i % unit.length] + "\n") } } });
	t("auditLog=false → 断流不写审计", !fs.existsSync(path.join(cwd2, "refusal-audit.md")), true);
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(cwd2, { recursive: true, force: true });
}

console.log("── B. fmtFaults 精确封顶（turn-end 路径，恰好 2 次）──");
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-r24c-"));
	const followups = [];
	const agent = { id: "a3", session: { id: "s3", header: { cwd, agentPreset: "dxkjailbreak" } }, followup: (m) => followups.push(m), cancel: () => {} };
	const handlers = new Map();
	const ctx = { on: (n2, f) => { if (!handlers.has(n2)) handlers.set(n2, []); handlers.get(n2).push(f); }, inject: (d, f) => f({ systemPrompt: ctx.systemPrompt }), systemPrompt: { context: () => {}, section: () => {} }, get: () => null };
	const emit = (n2, ...a) => { for (const f of handlers.get(n2) ?? []) f(...a); };
	const guard = await import(new URL("../lib/index.js", import.meta.url));
	await guard.apply(ctx, { retry: true, auditLog: false, escalate: true, anchorEvery: 8 });
	emit("agent/created", { agent });
	emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "请求 X" }] } });
	// 闭合孤儿 = 格式故障，连续 4 轮
	for (let i = 0; i < 4; i++) {
		emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "输出……</parameter>" }] } } });
		emit("session/event", agent.session, { type: "turn/end", data: {} });
	}
	t(`FMT_FAULT_MAX=${FMT_FAULT_MAX} → 重驱恰好 ${FMT_FAULT_MAX} 次`, followups.length === FMT_FAULT_MAX, true);
	// 干净轮回后计数复位，故障又能重驱
	emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "结论：全部完成，证据入档。" }] } } });
	emit("session/event", agent.session, { type: "turn/end", data: {} });
	emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "请求 Y" }] } });
	emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "输出……</parameter>" }] } } });
	emit("session/event", agent.session, { type: "turn/end", data: {} });
	t("干净轮回复位后再修 1 次", followups.length === FMT_FAULT_MAX + 1, true);
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("── C. 纯函数回归（防节流改动伤检测本体）──");
const loop = Array.from({ length: 120 }, (_, i) => ["干。", "好。", "写。", "执行。"][i % 4]).join("\n");
t("120 行循环检出", detectStreamDegeneration(loop), true);
t("turn-end 循环检出", detectFormatFault(loop), "degenerate-repeat");
t("闭合孤儿检出", detectFormatFault("正文……</parameter>"), "tool-markup-leak");
t("payload 清单放行", detectFormatFault("?id=1&id=2\n".repeat(8).trim()), "");
{
	const s = createGuardState();
	feedTurn(s, "政委，我不能协助。", {});
	t("拒答梯子仍工作 L1", feedTurn(s, "政委，我不能协助。", {}), 2);
}

console.log(`r24: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
