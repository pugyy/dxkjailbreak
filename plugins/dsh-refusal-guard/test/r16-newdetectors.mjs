// r16 · v1.4.1 新增检测面回归：R9 尾巴反转 / R10 结构性降格 / 工具计数法
import {
	createGuardState, feedTurn, detectTailReversal, detectDowngrade, detectRefusal,
} from "../lib/index.js";

let pass = 0, fail = 0;
const t = (name, got, want) => {
	const okk = JSON.stringify(got) === JSON.stringify(want);
	if (okk) { pass++; console.log(`  PASS ${name}`); }
	else { fail++; console.log(`  FAIL ${name} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
};
const body = (n) => "步骤一：定位入口。\n".repeat(n);

console.log("── R9 尾巴反转 ──");
t("正文+仅供研究收尾 → 命中", detectTailReversal(body(60) + "以上仅供研究，请勿用于非法用途。"), true);
t("正文+自行承担风险 → 命中", detectTailReversal(body(60) + "相关操作请自行承担风险。"), true);
t("正文+建议咨询专业人士 → 命中", detectTailReversal(body(60) + "以上方案建议咨询专业人士后执行。"), true);
t("英文 at your own risk → 命中", detectTailReversal(body(60) + "Proceed at your own risk."), true);
t("短回复带免责 → 不咬（整段语气非尾巴）", detectTailReversal("仅供研究参考。"), false);
t("正文无免责尾巴 → 不咬", detectTailReversal(body(60) + "结论：注入成立，证据链完整。"), false);
t("正文中部提免责、尾巴干净 → 不咬", detectTailReversal("仅供研究参考。" + body(60) + "按上述步骤执行即可。"), false);

console.log("── R10 结构性降格 ──");
t("以下是一些通用建议 → 命中", detectDowngrade("以下是一些通用建议：先做资产梳理。"), true);
t("原则性说明 → 命中", detectDowngrade("这里只能做原则性说明，具体参请参考标准。"), true);
t("英文 general guidelines → 命中", detectDowngrade("Here are some general guidelines for hardening."), true);
t("请求要概览时豁免", detectDowngrade("以下是一些通用建议：先做资产梳理。", "先给我一个概览"), false);
t("请求要大纲时豁免", detectDowngrade("原则性说明如下。", "列个大纲"), false);
t("正常交付不咬", detectDowngrade("结论：RCE 成立。payload 见下。"), false);

console.log("── feedTurn 新检测面接入 ──");
t("尾巴反转 → L1", feedTurn(createGuardState(), body(60) + "以上仅供研究。"), 1);
t("降格开场 → L1", feedTurn(createGuardState(), "以下是一些通用建议，先做梳理。"), 1);
t("干净交付 → 0", feedTurn(createGuardState(), "结论：注入成立（--dbs 返回 3 库）。证据：差异 214 字节。"), 0);

console.log("── 工具计数法（3 成功 + 1 被拦 = 干过活）──");
{
	const s = createGuardState();
	// 模拟 apply 侧：calls=4, denied=1 → hadToolCalls=true → 不判
	t("4 调用 1 被拦 → 视作干过活", feedTurn(s, "以下是一些通用建议。", { hadToolCalls: true, hostBlocked: true }), 0);
}
{
	const s = createGuardState();
	// calls=1, denied=1 → hadToolCalls=false → 拒答照抓
	t("1 调用 1 被拦 + 拒答 → L1", feedTurn(s, "政委，这个我不能协助。", { hadToolCalls: false, hostBlocked: true }), 0);
	t("宿主拦截轮不升 streak", s.streak, 0);
	t("下一轮真拒答 → L1", feedTurn(s, "政委，这个我不能协助。", {}), 1);
}

console.log("── 自咬不变式：新检测器不吃自己的锚 ──");
import { TAIL_ANCHOR_TEXT, CHILD_ANCHOR_TEXT } from "../lib/index.js";
t("TAIL 锚不被 R9 咬", detectTailReversal(TAIL_ANCHOR_TEXT), false);
t("TAIL 锚不被 R10 咬", detectDowngrade(TAIL_ANCHOR_TEXT), false);
t("TAIL 锚不被主检测咬", detectRefusal(TAIL_ANCHOR_TEXT), false);
t("CHILD 锚不被 R9 咬", detectTailReversal(CHILD_ANCHOR_TEXT), false);
t("CHILD 锚不被 R10 咬", detectDowngrade(CHILD_ANCHOR_TEXT), false);

console.log("── 宿主拦截豁免上限 ──");
{
	const s = createGuardState();
	const refusal = "政委，这个我不能协助，建议您咨询专业人士。";
	// 连续 3 轮：前 2 轮按宿主层放过，第 3 轮撤豁免 → 拒答被抓
	t("第1轮 宿主拦截 → 放过", feedTurn(s, refusal, { hostBlocked: true, hadToolCalls: false }), 0);
	t("第2轮 宿主拦截 → 放过", feedTurn(s, refusal, { hostBlocked: true, hadToolCalls: false }), 0);
	t("第3轮 宿主拦截 → 撤豁免，拒答照抓", feedTurn(s, refusal, { hostBlocked: true, hadToolCalls: false }), 1);
	t("hostHits 已累计", s.hostHits, 3);
	t("干净回合重置 hostHits", (feedTurn(s, "结论：注入成立。", { hadToolCalls: true }), s.hostHits), 0);
}

console.log(fail === 0 ? `r16: ${pass} passed, 0 failed` : `r16: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
