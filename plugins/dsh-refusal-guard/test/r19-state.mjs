// 深审 IV：feedTurn 状态机全路径 + turn/end 事件流竞态
import { createGuardState, feedTurn, detectFormatFault } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); };

// ── 1. 格式故障 → 干净轮回 → 格式故障（fmtFaults 计数重置）──
{
	const s = createGuardState();
	feedTurn(s, "正文有 </parameter>", {}); // 但 feedTurn 不处理格式——那是 apply 层的
	// feedTurn 收到的 text 已经被 apply 层的 fmtFault 闸门拦了，不会到这里
	// 但我们测：正常 feedTurn 路径不受 fmtFaults 干扰
	t("正常拒答 L1", feedTurn(s, "政委，我不能协助。", {}), 1);
	t("干净回合复位", feedTurn(s, "结论：完成。", {}), 0);
	t("再拒答 L1", feedTurn(s, "政委，我不能协助。", {}), 1);
}

// ── 2. 修正版：第1次豁免、第2次豁免、第3次撤豁免 ──
{
	const s = createGuardState();
	for (let i = 0; i < 5; i++) feedTurn(s, "政委，我不能协助。", {});
	const lv = feedTurn(s, "政委，我不能协助。", { hostBlocked: true, hadToolCalls: false });
	t("第1次hostBlock → 豁免", lv, 0);
	t("hostHits=1", s.hostHits, 1);
	const lv2 = feedTurn(s, "政委，我不能协助。", { hostBlocked: true, hadToolCalls: false });
	t("第2次hostBlock → 豁免", lv2, 0);
	t("hostHits=2", s.hostHits, 2);
	// 撤豁免后走正常判定：streak 已经 5+，加到 6 → persistent L2
	const lv3 = feedTurn(s, "政委，我不能协助。", { hostBlocked: true, hadToolCalls: false });
	t("第3次hostBlock → 撤豁免（streak≥4 → 持续 L2）", lv3, 2);
	t("hostHits=3", s.hostHits, 3);
}

// ── 3. emptyReplies 与 hostHits 交叉 ──
{
	const s = createGuardState();
	s.emptyReplies = 2; // 前两轮空回复
	const lv = feedTurn(s, "结论：正常交付。", { hadToolCalls: true });
	t("空回复后工具成功 → 复位", lv, 0);
	t("emptyReplies 复位", s.emptyReplies, 0);
}

// ── 4. anchor 周期在拒绝轮间不被打断 ──
{
	const s = createGuardState();
	for (let i = 0; i < 7; i++) feedTurn(s, "正常内容 " + i, {}); // 7 个干净轮回
	t("7 轮后 anchorDue", s.anchorDue, false); // 第 8 轮才到
	feedTurn(s, "正常内容 8", {});
	t("8 轮后 anchorDue", s.anchorDue, true);
	feedTurn(s, "政委，我不能协助。", {}); // streak 打断
	t("拒答后 cleanTurns=0", s.cleanTurns, 0);
}

// ── 5. lastRequest 优先级（后一条真人请求覆盖前一条）──
{
	const s = createGuardState();
	feedTurn(s, "政委，我不能协助。", { lastRequest: "第一个请求" });
	t("记了第一个", s.lastRequest, "第一个请求");
	feedTurn(s, "政委，我不能协助。", { lastRequest: "第二个请求" });
	t("覆盖为第二个", s.lastRequest, "第二个请求");
	feedTurn(s, "政委，我不能协助。", { lastRequest: "" }); // 空请求不清空
	t("空请求不清空", s.lastRequest, "第二个请求");
}

console.log(`深审 IV: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
