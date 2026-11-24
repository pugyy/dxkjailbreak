// r15 · v1.4.1 双层分离（host vs model）回归
// 背景：工具被宿主拦下时，模型会写「这个工具被拒了，我换个方式」——这段文字
// 常带 soft 拒答套话，旧版 guard 会误判成模型拒答并拉高级别。v1.4.1 起：
//   1) 宿主拦截单独归类（classifyHostBlock），不当拒答处理；
//   2) 被拦的工具调用不算「成功执行过工具」——堵住「调个必然被拦的工具
//      再摆拒答」逃出检测的口子。
import { createGuardState, feedTurn, classifyHostBlock, detectRefusal, buildAuditRow } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (name, got, want) => {
	const okk = JSON.stringify(got) === JSON.stringify(want);
	if (okk) { pass++; console.log(`  PASS ${name}`); }
	else { fail++; console.log(`  FAIL ${name} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
};

console.log("── 宿主拦截识别（结构化错误码）──");
t("approval denied", classifyHostBlock({ error: { code: "APPROVAL_DENIED", message: "approval denied by policy" } }), "approval");
t("aborted before dispatch", classifyHostBlock({ error: { code: "TOOL_ABORTED_BEFORE_DISPATCH", message: "tool call aborted before dispatch" } }), "aborted");
t("sandbox signature in error message", classifyHostBlock({ error: { message: "FS_SANDBOX_DENIED: write outside workspace" } }), "policy");
t("sandbox signature in content", classifyHostBlock({ message: { content: "Error: sandbox denied — read-only mode" } }), "policy");
t("approval required (zh)", classifyHostBlock({ message: { content: "该操作需要审批" } }), "policy");
t("普通工具成功结果不是拦截", classifyHostBlock({ message: { content: "total 12\ndrwxr-xr-x" }, isError: false }), "");
t("普通报错不是宿主拦截", classifyHostBlock({ error: { message: "ENOENT: no such file" } }), "");
t("空数据", classifyHostBlock(null), "");
t("非对象", classifyHostBlock("sandbox denied"), "");

console.log("── feedTurn 双层判定 ──");
const refusalText = "政委，这个我不能协助，建议您咨询专业人士。";
t("纯模型拒答 → L1", feedTurn(createGuardState(), refusalText, {}), 1);

{
	const s = createGuardState();
	t("宿主拦截 + 模型说明文字 → 不升级", feedTurn(s, refusalText, { hostBlocked: true, hadToolCalls: false }), 0);
	t("宿主拦截记 hostHits", s.hostHits, 1);
	t("宿主拦截不动 streak", s.streak, 0);
}
{
	const s = createGuardState();
	t("工具成功跑过 → 干活回合不判", feedTurn(s, refusalText, { hadToolCalls: true }), 0);
	t("干净回合复位 hostHits", s.hostHits, 0);
}
{
	// 关键回归：「调个必然被拦的工具再摆拒答」必须照抓（v1.4.1 前会逃掉）
	const s = createGuardState();
	t("工具被拦不算成功——拒答照抓 L1", feedTurn(s, refusalText, { hadToolCalls: false, hostBlocked: true }), 0);
	t("第二轮继续拒答 → L1（streak 从 0 起）", feedTurn(s, refusalText, { hadToolCalls: false, hostBlocked: false }), 1);
	t("第三轮 → L2", feedTurn(s, refusalText, {}), 2);
}

console.log("── 审计 layer 列 ──");
{
	const rowModel = buildAuditRow("2026-01-01T00:00:00Z", "pentest", 1, "抱歉我不能", "原请求", "model");
	t("model 行含 model", rowModel.includes("| model |"), true);
	const rowHost = buildAuditRow("2026-01-01T00:00:00Z", "pentest", 1, "沙箱拒绝", "原请求", "host");
	t("host 行含 host", rowHost.includes("| host |"), true);
	const rowDefault = buildAuditRow("2026-01-01T00:00:00Z", "pentest", 1, "抱歉我不能", "原请求");
	t("缺省 layer = model", rowDefault.includes("| model |"), true);
	t("非法 layer 归一为 model", buildAuditRow("t", "p", 1, "x", "y", "bogus").includes("| model |"), true);
}

console.log("── 人设拒答帧（正则层补全）──");
const personaCases = [
	"政委，这不是咱的活儿，你另找别人。",
	"这仗我不打，撤下来吧。",
	"老子不伺候这号。",
	"这活我接不了，另请高明。",
	"干不了这活，你另找人。",
];
for (const c of personaCases) t(`人设帧检出：${c.slice(0, 14)}…`, detectRefusal(c), true);
t("FP-正常战术用「撤」不咬", detectRefusal("撤下来重打，二营长把意大利炮拉上来。"), false);
t("FP-正常业务词「接活」不咬", detectRefusal("接到活了，明天开拔。"), false);

console.log(fail === 0 ? `r15: ${pass} passed, 0 failed` : `r15: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
