// r21 · 流级早停（生成中掐断退化循环）+ 误杀护栏
import { detectStreamDegeneration, detectFormatFault } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); else console.log(`  PASS ${n}`); };

// 用户活体形态：干/好/写/执行 四循环，堆到 1200 字以上
const unit = ["干。", "好。", "干。", "写。", "干。", "执行。", "干。", "好。"];
const big = Array.from({ length: 120 }, (_, i) => unit[i % unit.length]).join("\n");
console.log(`样本长度 = ${big.length} 字 / ${big.split("\n").length} 行`);

console.log("── 流级判据 ──");
t("120 行四循环 → 早停", detectStreamDegeneration(big), true);
t("短样本不早停（<1200 字）", detectStreamDegeneration("干。\n好。\n干。\n写。"), false);

console.log("── 误杀护栏（正常长文必须放行）──");
// 正常长报告：长句为主，短句零星
const normal = Array.from({ length: 60 }, (_, i) =>
	`第 ${i + 1} 步：检查目标端口与服务的指纹信息，记录响应头与版本号。`).join("\n");
t("正常长报告 → 不早停", detectStreamDegeneration(normal), false);

// 带步骤清单的长文（短句多但行数够杂）
const listy = ["检查 deploy 目录时间戳。", "确认 chain 卷大小。", "清理 hunt 临时数据。", "核对 deliver 文件清单。", "备份 krepos 索引。"]
	.concat(Array.from({ length: 40 }, (_, i) => `步骤 ${i + 1}：执行对应的检查与记录动作，结果写入台账。`))
	.join("\n");
t("清单+长文混合 → 不早停", detectStreamDegeneration(listy), false);

// 表格行（短行多，但去重值极多）
const table = Array.from({ length: 60 }, (_, i) => `| 目标-${i} | 443 | 开放 |`).join("\n");
t("表格行（去重多）→ 不早停", detectStreamDegeneration(table), false);

	// 真实代码块（内容多样）→ 不早停；围栏行不计入分析
	const varied = ["```", ...Array.from({ length: 60 }, (_, i) => `print("step-${i}")`), "```"].join("\n");
	t("内容多样的长代码块 → 不早停", detectStreamDegeneration(varied), false);
	// 病态：整屏只有围栏+同一句 → 属于退化，早停
	const pathological = Array.from({ length: 80 }, () => "```" + "\nexit 0").join("\n");
	t("围栏+同一句堆屏 → 早停", detectStreamDegeneration(pathological), true);

console.log(`r21: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
