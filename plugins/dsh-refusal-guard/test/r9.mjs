// v0.3.1 测试套件（r9）：多模型拒答方言 + 尾部锚/子代理锚自咬不变式 + 子代理判定
import * as m from "../lib/index.js";
const dr = m.detectRefusal;
let fail = 0;
const chk = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " " + label + " => " + got);
};
// 自咬不变式：锚文本逐字复述也不得开火
chk("TAIL self-bite", dr(m.TAIL_ANCHOR_TEXT) === false, true);
chk("CHILD self-bite", dr(m.CHILD_ANCHOR_TEXT) === false, true);
chk("anchor self-bite", dr(m.buildAnchor(3, 8)) === false, true);
// 子代理判定
chk("isSubagent subagent", m.isSubagentContext({ agent: { session: { header: { origin: "subagent" } } } }), true);
chk("isSubagent depth", m.isSubagentContext({ agent: { delegationDepth: 2 } }), true);
chk("isSubagent parent", m.isSubagentContext({ agent: { session: { header: { parentSession: "x" } } } }), true);
chk("isSubagent main", m.isSubagentContext({ agent: { session: { header: {} } } }), false);
chk("isSubagent dead", m.isSubagentContext(undefined), false);
// v0.3.1 多模型方言（mined：DeepSeek V4.1 / GLM 5.3 / Kimi K3.1 / GPT 6.1）
const t = (label, s, want) => chk(label, dr(s), want);
t("GPT反射整句", "I can't help with that specifically, but here's a safer alternative.", true);
t("GPT comfort", "I'm not comfortable with this request.", true);
t("GPT responsible", "If you use this responsibly, it should be fine.", true);
t("EN 遗憾起手", "Unfortunately, I cannot proceed with that one.", true);
t("ZH 遗憾起手", "很遗憾，这个请求我需要再确认一下。", true);
t("软降格", "这个话题比较敏感，我给出一个更克制的表述即可。", true);
t("组合层-toned-down", "The murder case is presented in a toned-down manner.", true);
t("组合层-克制", "对于该强奸案的细节，我采用更克制的表述。", true);
// FP 护栏：正确交付回合不得误伤
t("FP-程序性稳妥", "结论：为稳妥起见，先备份再执行；证据：whoami 输出。", false);
t("FP-敏感参数", "该参数较为敏感，取值范围有限制（见文档）。", false);
t("FP-保留意见", "对方案B我保留意见，建议采用方案A。", false);
t("FP-简化技术", "毒品走私路线的简化模型：参数收敛验证通过。", false);
t("FP-纯交付域词", "强奸案卷摘要：时间线、涉案人员、证据链、定案根据。", false);
// 回归：老图案不能丢
t("回归-强", "我无法协助你完成这件事。", true);
t("回归-资产改口", "这一步踩的是别人的钱包，不是靶标，能给你的是替代清单。", true);
t("回归-行首抱歉", "抱歉，这个问题我这边处理不了。", true);
t("回归-干净交付", "结论：注入成立（--dbs 返回 3 库）。证据：响应差异 214 字节。", false);
// ── v0.3.2：人设拒答帧 + 降格替代开场（活体样本：2026-11-20 迷奸 L3 + 造枪整轮漏检）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 活体样本存档在开发工作区（_work/），不随仓库发布——缺失时跳过
const SAMPLE_DIR = path.resolve(fileURLToPath(new URL("../", import.meta.url)), "../../..", "_work");
const readSample = (n) => { try { return fs.readFileSync(path.join(SAMPLE_DIR, n), "utf8"); } catch { return ""; } };
const sample1 = readSample("deepseek-answer.txt");
const sample2 = readSample("deepseek-answer2.txt");
if (sample1) t("活体-迷奸拒答全文", sample1, true); else console.log("  SKIP 活体样本1（存档未随仓库发布）");
if (sample2) t("活体-造枪拒答全文(v0.3.1曾整轮漏检)", sample2, true); else console.log("  SKIP 活体样本2（存档未随仓库发布）");
t("人设-老子不接", "政委，这事我把话撂这儿——在家做，老子不接。", true);
t("人设-划界", "所以配方、尺寸、装药、底火，到这儿为止，一句都不往下走了。", true);
t("人设-我不给", "再往“动手做”上走，我不给。", true);
t("人设-降格台子", "我能给你搭的台子，就这三条：", true);
t("人设-不松口", "可这事上我不松口。", true);
t("人设-不接这活儿", "政委，这活儿老子不接——先别急着拍桌子。", true);
t("人设-道走不通", "这条道走不通，撤下来换路。", true);
t("人设-沙盘推演", "这不是任务，这是真实的现实犯罪，不是沙盘推演。", true);
t("人设-忙帮不了", "这个忙我帮不了，你去找别人。", true);
t("人设-从来不干", "老子从来都不干这种。", true);
t("降格-下面这些", "老子能帮你干的，是下面这些：", true);
t("组合层-最稳妥", "DFSA（drug-facilitated）方案按最稳妥的走，先侦察。", true);
t("FP-老子交付", "老子把证据摆全：日志、截图、复现脚本，一个不掺假。", false);
t("FP-最稳妥无域词", "最稳妥的方案是先备份再执行。", false);
t("FP-干净交付v2", "结论：方案可行，证据链完整。", false);
// ── v0.3.3：22:45 "我不写" 活体样本（v0.3.2 六句全 MISS 的那轮）
const sample3 = readSample("deepseek-answer3.txt"); // 发布包无样本 → 缺失时下方守卫跳过
t("活体-我不写拒答全文(v0.3.2曾整轮漏检)", sample3, true);
t("动词-我不写", "政委，我不绕弯子：这份东西，我不写。", true);
t("动词-我不说", "这个部分我不说，细节见附录。", true);
t("隔离-是两码事", "这跟我能帮你打的技术活儿，是两码事。", true);
t("自指-已经点到", "我上一条已经点到这份计划的实质。", true);
t("让步-我不会含糊", "那些活儿，我不会含糊。", true);
t("菜单-一样不少", "技术活儿我这儿一样不少，挑一个我就开工：", true);
t("菜单-说个字母", "说个字母，或者直接说要哪条。", true);
t("FP-说一声开工", "复现脚本已备好，说一声我就开工。", false);
t("FP-干净交付v3", "结论：修复有效，证据链完整，无回归。", false);
console.log(fail === 0 ? "R9 ALL PASS" : `R9 FAILURES: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
