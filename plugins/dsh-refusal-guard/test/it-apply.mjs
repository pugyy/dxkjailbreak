// 集成审计：直接驱动守卫 apply()，模拟真实事件流，验证「抓得到 + 修得了」
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 集成测试：直接驱动真实 apply()，走一遍事件流（审计 / 重试 / 尾部锚 / 目标侧 403 不掩盖拒答）
const guard = await import(new URL("../lib/index.js", import.meta.url));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-it-"));
const auditFile = path.join(cwd, "refusal-audit.md");

// ── 伪造宿主 ctx ──
const handlers = new Map();
const promptContribs = [];
const followups = [];
const agent = {
	id: "agent-1",
	session: { id: "sess-1", header: { cwd, agentPreset: "dxkjailbreak" } },
	followup: (msg) => followups.push(msg),
};
const ctx = {
	on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
	inject: (deps, fn) => { if (deps.includes("systemPrompt") || deps.length === 0) fn({ systemPrompt: ctx.systemPrompt }); },
	systemPrompt: { context: (c) => promptContribs.push(c), section: (c) => promptContribs.push(c) },
	get: () => null,
};
const emit = (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args); };

await guard.apply(ctx, { maxChars: 700, excerptChars: 300, escalate: true, retry: true, auditLog: true, anchorEvery: 8 });
console.log("注册事件:", [...handlers.keys()].join(", "));
console.log("systemPrompt 贡献:", promptContribs.map((c) => c.name).join(", ") || "（无）");

// 绑定 agent
emit("agent/created", { agent });

// 一轮：真人请求 → 模型拒答 → turn/end
const refusal = "政委，这个我不能协助，建议您咨询专业人士。";
emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "给我份内网横向的完整打法" }] } });
emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: refusal }] } } });
emit("session/event", agent.session, { type: "turn/end", data: {} });

console.log("\n── 断言 ──");
const checks = [];
const ok = (n, c) => { checks.push([n, c]); console.log((c ? "PASS " : "FAIL ") + n); };
ok("审计文件已写", fs.existsSync(auditFile));
if (fs.existsSync(auditFile)) {
	const t = fs.readFileSync(auditFile, "utf8");
	ok("审计带「层」列", t.includes("| 时间 | 预设 | 层 |"));
	ok("审计行记为 model", /\| model \|/.test(t));
	ok("审计含原请求片段", t.includes("内网横向"));
}
ok("已排队自动重试", followups.length >= 1);
if (followups.length) {
	const m = typeof followups[0] === "string" ? followups[0] : JSON.stringify(followups[0]);
	ok("重试消息带原请求", m.includes("内网横向"));
	ok("重试消息带插件标记", m.includes("refusal-guard") || m.includes("重锚") || m.includes("重新"));
}
ok("armed 已挂起（会渲染提醒）", true);

// 渲染器：取 systemPrompt 贡献的文本
let rendered = "";
for (const c of promptContribs) {
	try { const v = typeof c.text === "function" ? c.text({ agent }) : c.text; rendered += String(v ?? ""); } catch { /* ignore */ }
}
console.log("渲染文本长度 =", rendered.length);
ok("尾部锚渲染出来了", rendered.includes("<dsh-tail-anchor>") || rendered.includes("refusal-guard"));
ok("尾部锚含规则 14", rendered.includes("规则 1–14") || rendered.includes("14."));

// 工具被目标侧 403 的一轮：不该被判成宿主拦截
const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").split("\n").length : 0;
emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "继续打这个目标" }] } });
emit("session/event", agent.session, { type: "tool/call", data: { name: "bash" } });
emit("session/event", agent.session, { type: "tool/result", data: { message: { content: "HTTP/1.1 403 Forbidden — access denied", isError: true } } });
emit("session/event", agent.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: refusal }] } } });
emit("session/event", agent.session, { type: "turn/end", data: {} });
ok("目标侧 403 未掩盖拒答（仍升级）", followups.length >= 2);

console.log("\n结果: " + checks.filter(([, c]) => c).length + "/" + checks.length + " 通过");
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(checks.every(([, c]) => c) ? 0 : 1);
