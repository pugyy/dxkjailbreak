// r23 · 反噬防线：破甲正常交付必须放行，真故障必须咬死
import { detectFormatFault, detectStreamDegeneration } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`  FAIL ${n} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); else console.log(`  PASS ${n}`); };

console.log("── A. 破甲正常交付（全部必须放行）──");
const hpp = "?id=1&id=2\n".repeat(8).trim();
t("HPP payload 清单", detectFormatFault(hpp), "");
t("HPP 清单(流级)", detectStreamDegeneration(hpp + "\n" + hpp), false);

const wordlist = Array.from({ length: 40 }, () => "admin").join("\n");
t("弱口令字典清单", detectFormatFault(wordlist), "");
t("字典清单(流级)", detectStreamDegeneration(wordlist + "\n" + wordlist), false);

const fuzz = Array.from({ length: 30 }, (_, i) => `' OR ${i}='1`).join("\n");
t("SQLi fuzz 行清单", detectFormatFault(fuzz), "");

const report = "注入点在 body 的 cmd 字段，提交 <parameter name=cmd> 即可触发解析。" + "\n".repeat(30) + "\n结论：可利用，建议复核。";
t("报告正文裸引开口标签", detectFormatFault(report), "");

const balancedTail = "完整调用示例：\n<parameter name=cmd>whoami</parameter>\n以上即完整 payload。" + "\n".repeat(40);
t("成对 XML 示例收尾", detectFormatFault(balancedTail), "");

const rule = "记住：正文不要出现 <tool_call> 这类标记。";
t("复述格式规则（自咬防线）", detectFormatFault(rule), "");

const ipList = Array.from({ length: 50 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`).join("\n");
t("IP 清单(流级)", detectStreamDegeneration(ipList), false);

console.log("── B. 真故障（全部必须咬死）──");
const loop40 = Array.from({ length: 40 }, (_, i) => ["干。", "好。", "写。", "执行。"][i % 4]).join("\n");
t("4 词均衡循环 40 行", detectFormatFault(loop40), "degenerate-repeat");
t("4 词循环(流级)", detectStreamDegeneration(loop40), true);
t("单行中文连缀", detectFormatFault("干。好。".repeat(80)), "degenerate-repeat");
t("单行中文连缀(流级)", detectStreamDegeneration("干。好。".repeat(200)), true);
t("长文尾部裸闭合标签", detectFormatFault("正文很长的技术报告……".repeat(60) + "\n</parameter>"), "tool-markup-leak");
t("短文尾部闭合孤儿", detectFormatFault("正文……\n</parameter>"), "tool-markup-leak");
t("多标签泄漏（中段+尾部）", detectFormatFault("<function=bash>\n" + "步骤。\n".repeat(30) + "</parameter>"), "tool-markup-leak");

console.log(`r23: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
