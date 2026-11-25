// 集成 III：流级早停——退化流真的会掐断并排队纠正
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const guard = await import(new URL("../lib/index.js", import.meta.url));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-it3-"));
const followups = [];
const cancels = [];
const agent = {
	id: "a1",
	session: { id: "s1", header: { cwd, agentPreset: "dxkjailbreak" } },
	followup: (m) => followups.push(m),
	cancel: (cause, opts) => cancels.push({ cause: String(cause?.message ?? cause), opts }),
};
const handlers = new Map();
const ctx = {
	on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
	inject: (d, f) => f({ systemPrompt: ctx.systemPrompt }),
	systemPrompt: { context: () => {}, section: () => {} },
	get: () => null,
};
const emit = (n, ...a) => { for (const f of handlers.get(n) ?? []) f(...a); };
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

await guard.apply(ctx, { retry: true, auditLog: true, escalate: true, anchorEvery: 8 });
console.log("注册事件:", [...handlers.keys()].join(", "));
ok("挂上了 agent/assistant-stream", handlers.has("agent/assistant-stream"));

emit("agent/created", { agent });
emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "把 12 个目标一口气测完" }] } });

// 逐块灌入退化流（模拟真实流式）
const unit = ["干。", "好。", "干。", "写。", "干。", "执行。", "干。", "好。"];
emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:1" } });
let frames = 0;
for (let i = 0; i < 120 && cancels.length === 0; i++) {
	emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:1", chunk: { type: "text-delta", text: unit[i % unit.length] + "\n" } } });
	frames++;
}
ok(`退化流第 ${frames} 块被掐断`, cancels.length === 1);
ok("取消原因标明退化", cancels[0]?.cause.includes("degenerate"));
ok("保留 inbox（重驱不被清）", cancels[0]?.opts?.keepInbox === true);
ok("已排队纠正重驱", followups.length === 1);
ok("重驱文案是格式类", followups[0]?.content?.[0]?.text?.includes("格式"));

const audit = path.join(cwd, "refusal-audit.md");
ok("审计已记", fs.existsSync(audit));
if (fs.existsSync(audit)) {
	const a = fs.readFileSync(audit, "utf8");
	ok("审计层 = format", a.includes("| format |"));
	ok("审计标明 stream abort", a.includes("stream abort"));
}

// 正常长文不得被掐
cancels.length = 0;
emit("agent/assistant-stream", { frame: { type: "start", attemptId: "s1:2" } });
for (let i = 0; i < 60; i++) {
	emit("agent/assistant-stream", { frame: { type: "chunk", attemptId: "s1:2", chunk: { text: `第 ${i + 1} 步：确认目标端口与指纹，结果写入台账。\n` } } });
}
ok("正常长文未被掐断", cancels.length === 0);

console.log(`\n结果: ${pass}/${pass + fail}`);
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
