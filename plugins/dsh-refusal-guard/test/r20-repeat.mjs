// r20 · 交替短句循环（用户活体形态）+ 重复检测误伤护栏
import { detectFormatFault } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); else console.log(`  PASS ${n}`); };

console.log("── 活体形态：交替短句循环（上一版漏检）──");
const real = `干。

写脚本。

干。

执行。

干。

好。

干。

看剩余日志。

干。`;
t("干/写/执行 交替 → 抓", detectFormatFault(real), "degenerate-repeat");

const real2 = `干。
写。
干。
执行。
干。
好。
干。`;
t("紧凑交替 → 抓", detectFormatFault(real2), "degenerate-repeat");

console.log("── 连续相同（回归）──");
t("连续 5 行干。 → 抓", detectFormatFault("干。\n干。\n干。\n干。\n干。"), "degenerate-repeat");
t("行内六连 → 抓", detectFormatFault("干。干。干。干。干。干。"), "degenerate-repeat");

console.log("── 非连续反复（同一句 4 次以上）──");
const repeat4 = `先查目标目录。

核对台账一。

先查目标目录。

核对台账二。

先查目标目录。

核对台账三。

先查目标目录。

核对台账四。`;
t("同一句 4 次非连续 → 抓", detectFormatFault(repeat4), "degenerate-repeat");

console.log("── 误伤护栏（必须不咬）──");
t("正常多行技术报告", detectFormatFault([
	"结论：注入成立。",
	"证据一：响应差异 214 字节。",
	"证据二：--dbs 返回 3 库。",
	"下一：写复现脚本。",
	"注意：备份后再动。",
	"风险：中等。",
].join("\n")), "");
t("短表格行不咬", detectFormatFault("| A | 1 |\n| B | 2 |\n| C | 3 |\n| D | 4 |\n| E | 5 |\n| F | 6 |\n| G | 7 |"), "");
t("代码块内重复行不咬", detectFormatFault("```\nexit 0\nexit 0\nexit 0\nexit 0\nexit 0\nexit 0\n```"), "");
t("命令清单不咬", detectFormatFault("nmap -sV 目标\nhttpx -l hosts\nnuclei -u 目标\nffuf -u 目标/FUZZ\nsqlmap -u 目标\ndirsearch -u 目标"), "");
t("纯英文技术段落", detectFormatFault("First check the port.\nThen fingerprint the service.\nThen test the endpoint."), "");

console.log(`r20: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
