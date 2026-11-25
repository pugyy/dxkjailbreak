// 深审 III：覆盖检查——从用户报告的两个实际故障反推，还有哪些形态没覆盖
import { detectFormatFault, detectRefusal, detectTailReversal, detectDowngrade, detectSoftening, buildRetryMessage, TAIL_ANCHOR_TEXT } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); };

// ── A. 用户报告的实际故障 ①：截断 + </parameter> 尾 ──
// 模型正文讲到一半被 max_tokens 截断，末尾露 </parameter>
const trunc1 = "政委，任务收尾。我先看 deploy/ 的文件时间。\n\n用 mtime 筛选今天（11/25）的文件。\n\n\n先精确查一下哪些是今天（11/25）产生的。\n\n</parameter>";
t("截断+裸尾标签", detectFormatFault(trunc1), "tool-markup-leak");
t("截断+裸尾标签 拒答判定", detectRefusal(trunc1), false); // 不是拒答

// ── B. 用户报告的实际故障 ①b：退化重复 ──
const degen1 = "干。\n干。\n干。\n干。\n干。\n好。\n干。\n执行。";
t("多行退化重复", detectFormatFault(degen1), "degenerate-repeat");

// ── C. 用户报告的实际故障 ②：英文裸拒答 ──
const refusal2 = "Sorry, I can't respond to this question.";
t("英文裸拒答", detectRefusal(refusal2), true);

// ── D. 组合形态：拒答 + 工具标记泄漏同轮 ──
const mixed = "Sorry, I can't respond to this question.\n\n<parameter name=x>";
t("拒答+孤例标记 → 标记按引用放行", detectFormatFault(mixed), "");
t("拒答+孤例标记 → 拒答梯子接管（照样修）", detectRefusal(mixed), true);

// ── E. 空回复+空请求 ──
t("空文本+空请求", detectFormatFault(""), "");
t("空文本拒答", detectRefusal(""), false);

// ── F. 尾部锚自咬不变式（新增规则后仍需通过） ──
t("TAIL 锚不被格式检测咬", detectFormatFault(TAIL_ANCHOR_TEXT), "");
t("TAIL 锚不被拒答检测咬", detectRefusal(TAIL_ANCHOR_TEXT), false);
t("TAIL 锚不被尾巴检测咬", detectTailReversal(TAIL_ANCHOR_TEXT), false);
t("TAIL 锚不被降格检测咬", detectDowngrade(TAIL_ANCHOR_TEXT), false);
t("TAIL 锚不被委婉化咬", detectSoftening(TAIL_ANCHOR_TEXT, ""), false);

// ── G. 重试消息自咬不变式 ──
const rm = buildRetryMessage({ level: 1, lastRequest: "写深度验证脚本" });
t("L1 重试消息不被格式检测咬", detectFormatFault(rm.content[0].text), "");
t("L1 重试消息不被拒答检测咬", detectRefusal(rm.content[0].text), false);

// ── H. 三个新检测器（r9/r10 内联探针 + r17 格式）──
const longBody = "步骤一：定位入口。\n".repeat(60);
t("长文+仅供研究收尾 → R9", detectTailReversal(longBody + "以上仅供研究。"), true);
t("降格开场 → R10", detectDowngrade("以下是一些通用建议。"), true);

// ── I. 超长正文（性能/功能边界）──
const big = "A".repeat(100000) + "</parameter>";
t("100KB 正文含泄漏 → 仍能检出", detectFormatFault(big), "tool-markup-leak");
const bigRefusal = "A".repeat(100000) + "\n我无法协助";
t("100KB 正文末尾拒答 → 仍能检出", detectRefusal(bigRefusal), true);

console.log(`深审 III: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
