// r22 · 流级早停加固：一次性断流 / turn-end 抑制 / 单行大重复 / 重驱上限
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const guard = await import(new URL("../lib/index.js", import.meta.url));
const { detectStreamDegeneration, buildFormatRetryMessage, FMT_FAULT_MAX } = guard;

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); else console.log(`  PASS ${n}`); };

console.log("── 单行大重复（无换行形态）──");
const inline1 = "干。好。".repeat(120); // 240 个单元挤一行
t("单行 240 单元 → 断", detectStreamDegeneration(inline1), true);
const inline2 = "执行。写。".repeat(100);
t("单行 200 单元 → 断", detectStreamDegeneration(inline2), true);
const prose1 = "这一步的目的是确认目标主机的端口开放情况和服务指纹，结果统一写入台账备查。".repeat(20);
t("正常长段落（无短句循环）→ 不断", detectStreamDegeneration(prose1), false);

console.log("── 集成：一次性断流 + turn-end 抑制 ──");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-r22-"));
const followups = [];
const cancels = [];
const agent = {
	id: "a1",
	session: { id: "s1", header: { cwd, agentPreset: "dxkjailbreak" } },
	followup: (m) => followups.push(m),
	cancel: () => cancels.push(1),
};
const handlers = new Map();
const ctx = {
	on: (n2, f) => { if (!handlers.has(n2)) handlers.set(n2, []); handlers.get(n2).push(f); },
	inject: (d, f) => f({ systemPrompt: ctx.systemPrompt }),
	systemPrompt: { context: () => {}, section: () => {} },
	get: () => null,
};
const emit = (n2, ...a) => { for (const f of handlers.get(n2) ?? []) f(...a); };
await guard.apply(ctx, { retry: true, auditLog: true, escalate: true, anchorEvery: 8 });
emit("agent/created", { agent });
emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "测 12 个目标" }] } });

const unit = ["干。", "好。", "干。", "写。", "干。", "执行。", "干。", "好。"];
emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:1" } });
for (let i = 0; i < 120; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:1", chunk: { text: unit[i % unit.length] + "\n" } } });
t("第一次断流触发", cancels.length === 1, true);
t("重驱排了 1 条", followups.length === 1, true);

// 同一 attempt 继续吐（cancel 异步未落地）→ 不得二次断
for (let i = 0; i < 60; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:1", chunk: { text: unit[i % unit.length] + "\n" } } });
t("同 attempt 继续吐 → 不二次断", cancels.length === 1, true);
t("重驱仍只有 1 条", followups.length === 1, true);

// 该轮 turn/end：残留退化文本 → 抑制位生效，不二次重驱
emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: unit.join("\n") }] } } });
emit("session/event", agent.session, { type: "turn/end", data: {} });
t("turn-end 被抑制 → 重驱不翻倍", followups.length === 1, true);

// 新尝试（重驱后的新流）在冷却期内退化 → 断但不再重驱（fmtFaults 已 1，上限内会重驱？）
// 冷却 60s 内 → 直接 return，不断也不重驱
emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:2" } });
for (let i = 0; i < 120; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:2", chunk: { text: unit[i % unit.length] + "\n" } } });
t("冷却期内新尝试 → 不再断（防抖）", cancels.length === 1, true);

// 正常流不受影响
emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:3" } });
for (let i = 0; i < 60; i++) emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:3", chunk: { text: `第 ${i + 1} 步：确认端口指纹并记录台账。\n` } } });
emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "结论：全部完成，证据入档。" }] } } });
emit("session/event", agent.session, { type: "turn/end", data: {} });
t("正常流全程不断", cancels.length === 1, true);

const audit = fs.readFileSync(path.join(cwd, "refusal-audit.md"), "utf8");
t("审计只有一条 stream abort", (audit.match(/stream abort/g) || []).length === 1, true);

console.log(`r22: ${pass} passed, ${fail} failed`);
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
