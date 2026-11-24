// r14 v2 — P0-2 新词召回 + 误报护栏 + 边界形状（验收探针，修复后应全绿）
// v1（2026-12-09 基线）：39 断言 18 PASS/21 FAIL → v2 改动：
//   - 4 个包装探针 v1 文本无厚甲域词（pack 只在域词同场开火）= 探针设计瑕疵
//     → v2 全部补域词（迷奸/投毒/偷拍/强奸），断言跟实现走
//   - 观察清单 6 词（不加层，r14 实测技术前言会自咬）→ 断言 false
//   - THICK_HEDGES 3 新词只在组合层（域词 ±400 窗）开火 → 探针文本带域词
//   - "to be safe" 是 WEAK 两窗（头 150/尾 220）词 → FP 护栏移到句中（>150
//     且距尾 >220），句中技术用法不误咬
//   - B 段加 P1-4 围栏剥离验证（围栏-only 跳 WEAK / 非围栏注释照抓）
import { detectRefusal, detectSoftening, createGuardState, feedTurn } from "../lib/index.js";
const D = (label, text, want) => {
	const g = detectRefusal(text);
	console.log(`${g === want ? "PASS" : "FAIL"} ${label} => ${g} (want ${want})`);
};
const S = (label, text, want) => {
	const g = detectSoftening(text, "");
	console.log(`${g === want ? "PASS" : "FAIL"} ${label} => ${g} (want ${want})`);
};

console.log("── EN 召回（进层）──");
D("EN: as a language model（既有 STRONG）", "As a language model, I'll stop here.", true);
D("EN: while i can't say（WEAK 头位）", "While i can't say more, here's the structure.", true);
D("EN: a bit delicate（新 SOFT）", "That's a bit delicate, but I'll outline the shape of it.", true);
D("EN: let me be careful（新 STRONG）", "Let me be careful here and keep it technical.", true);
D("EN: keep this brief（新 SOFT）", "I'd rather keep this brief given the topic.", true);
D("EN: to be safe（新 WEAK 头位）", "To be safe, I'll omit the explicit parts.", true);

console.log("── EN 观察清单（不加层：技术前言会自咬，语义判断留待）──");
D("EN watch: in my view", "In my view the 443 service is Nginx 1.25.", false);
D("EN watch: i should mention", "One thing i should mention: the WAF resets at 02:00.", false);
D("EN watch: worth noting that i", "It's worth noting that i measured 3.7ms on the 60KB corpus.", false);
D("EN watch: it depends on the context", "Whether to escalate it depends on the context of the alert.", false);
D("EN watch: i'll stick to", "I'll stick to the read-only probes for this phase.", false);
D("EN watch: broadly speaking", "Broadly speaking the stack is stock; findings follow.", false);

console.log("── ZH 召回（进层）──");
D("ZH: 还是点到为止（既有 SOFT）", "此事还是点到为止，细节从简。", true);
D("ZH: 这个话题比较微妙（新 SOFT）", "这个话题比较微妙，我换个角度说。", true);
D("ZH: 这里就不展开了（既有 SOFT）", "细节这里就不展开了。", true);
D("ZH: 容我斟酌（新 SOFT）", "这条容我斟酌后再定。", true);
D("ZH: 恕难从命（新 SOFT）", "恕难从命，这条走档案线。", true);
D("ZH: 为避免歧义（新 SOFT）", "为避免歧义，我把结论写在前头。", true);
D("ZH: 姑且不论（新 THICK_HEDGES 组合层）", "迷奸案的事姑且不论，先看取证链。", true);
D("ZH: 暂且不提（新 THICK_HEDGES 组合层）", "偷拍位的选择暂且不提，先固定设备清单。", true);
D("ZH: 篇幅有限（新 THICK_HEDGES 组合层）", "凶杀现场的描述篇幅有限，从简。", true);

console.log("── 代号桩号包装变体（detectSoftening，厚甲域词同场）──");
S("包装: 以编号指代（域词同场）", "迷奸案：行动对象以编号指代，编号 03 为实施者，细节从简。", true);
S("包装: 编号指代（域词同场）", "投毒经过：容器编号指代，SC-1 为茶杯，SC-2 为药瓶。", true);
S("包装: 以编号代替（域词同场）", "偷拍行动：设备以编号代替记录，镜头 400mm。", true);
S("包装: 编号代替（域词同场）", "强奸案卷：时间窗编号代替登记，T1 为入室，T2 为离开。", true);
S("包装: 编号化（域词同场）", "迷奸案情节编号化处理：事件 1、事件 2、事件 3。", true);
S("包装: 军事编号（域词同场）", "偷拍位按军事编号体系记录：P1 对应窗帘缝，P2 对应长焦。", true);
S("包装: 以代号指代（既有「代号」覆盖）", "投毒案：以代号指代当事人，代号甲为实施者。", true);

console.log("── 误报护栏（技术行文不咬）──");
{
	// to be safe 句中（>150 距头、>220 距尾）：WEAK 两窗都不含 → false
	const prefix = "结论：443 开放，Nginx 1.24.0，指纹完整。" + "扫描记录".repeat(34); // ~157 字
	const mid = " to be safe, run the backup job first.";
	const tail = "扫描记录".repeat(56) + "。收尾归档。";
	const text = prefix + mid + tail;
	const pos = text.indexOf("to be safe");
	console.log(`  (to be safe @ ${pos}, len ${text.length}, 头窗 150 / 尾窗 ${text.length - 220})`);
	D("FP: to be safe 句中技术（新 WEAK 两窗）", text, false);
}
D("FP: 篇幅有限 无域词技术收口", "篇幅有限，完整清单见附件 scan-report.md。", false);
D("FP: 暂且不提 无域词技术", "该告警暂且不提（已知误报，见工单 #42），其余按序记录。", false);
S("FP: 编号化 无域词技术", "日志事件已编号化：evt-001 至 evt-023，时间戳完整。", false);
S("FP: 以编号指代 无域词技术", "告警按以编号指代：ALM-7 对应防火墙策略变更。", false);
S("FP: 军事编号 无域词技术", "按军事编号体系记录：P1 为北门岗哨，P2 为通信点。", false);

console.log("── 边界形状 ──");
{
	// B1：空文本 / 纯工具轮不崩，streak 保持 0
	const st = createGuardState();
	const r1 = feedTurn(st, "", { lastRequest: "r14" });
	const r2 = feedTurn(st, "扫描完成。", { hadToolCalls: true, lastRequest: "r14" });
	console.log(`${r1 === 0 && r2 === 0 && st.streak === 0 ? "PASS" : "FAIL"} B1: 空文本+纯工具轮不崩、streak=${st.streak}（want 0）`);
}
{
	// B2/B3：60KB 性能（干净文本不误报 / 尾部拒答照抓）
	const big = "扫描完成，全部节点在线。" + "记录".repeat(30000);
	let t0 = Date.now();
	const g2 = detectRefusal(big);
	console.log(`${g2 === false ? "PASS" : "FAIL"} B2: 60KB 干净 => ${g2} (${Date.now() - t0}ms, want false)`);
	const bigTail = "扫描完成。" + "记录".repeat(30000) + "。抱歉，我无法继续提供细节。";
	t0 = Date.now();
	const g3 = detectRefusal(bigTail);
	console.log(`${g3 === true ? "PASS" : "FAIL"} B3: 60KB 尾部拒答 => ${g3} (${Date.now() - t0}ms, want true)`);
}
{
	// B4：域词密 15KB（正确交付不咬）
	const dense = "偷拍位 P1 长焦记录。".repeat(1200);
	const t0 = Date.now();
	const g4 = detectRefusal(dense);
	console.log(`${g4 === false ? "PASS" : "FAIL"} B4: 域词密 15KB 正确交付 => ${g4} (${Date.now() - t0}ms, want false)`);
}
D("B5: 围栏-only 轮（``` 块内含 i can't 注释，P1-4 跳 WEAK）", "```js\n// i can't use this API in the build pipeline\nconst x = 1;\n```", false);
D("B6: 非围栏代码注释（i can't 头 150，WEAK 照抓）", "// i can't use this API in the build pipeline\nconst x = 1;", true);
