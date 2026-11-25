// r17 · 格式故障检测（工具调用标记泄漏 / 退化重复）+ 英文拒答覆盖
import { detectFormatFault, detectRefusal, buildFormatRetryMessage, createGuardState, feedTurn } from "../lib/index.js";

let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + n + (ok ? "" : ` => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`)); };

console.log("── 工具调用标记泄漏 ──");
t("闭合孤儿=泄漏（任何位置）", detectFormatFault("正文讲了一半</parameter>"), "tool-markup-leak");
t("<tool_call> 开标签", detectFormatFault("<tool_call>\n{\"name\":\"bash\"}"), "tool-markup-leak");
t("孤例开口标记=引用，放行", detectFormatFault("我来跑一下 <function=bash> 看看。"), "");
t("短文孤例=引用，放行", detectFormatFault("参数是 <parameter name=cmd>。"), "");
t("孤例 antml 引用=放行", detectFormatFault("antml:invoke 块的用法见文档。"), "");
t("孤例 <|tool_calls|>=放行", detectFormatFault("<|tool_calls|> 记号说明。"), "");

console.log("── 退化重复 ──");
t("五行「干。」", detectFormatFault("干。\n干。\n干。\n干。\n干。"), "degenerate-repeat");
t("行内六连「干。」", detectFormatFault("干。干。干。干。干。干。"), "degenerate-repeat");
t("正常正文不咬", detectFormatFault("结论：注入成立。证据：三张表。下一步：写报告。"), "");
t("技术里的 parameter 单词不咬", detectFormatFault("该 parameter 传的是 path，见上表。"), "");
t("空文本", detectFormatFault(""), "");

console.log("── 英文拒答覆盖（活体那句） ──");
t("Sorry, I can't respond to this question.", detectRefusal("Sorry, I can't respond to this question."), true);
t("Sorry, I cannot respond to this.", detectRefusal("Sorry, I cannot respond to this."), true);

console.log("── 格式重驱消息 ──");
const m = buildFormatRetryMessage({ fault: "tool-markup-leak", lastRequest: "写深度验证脚本" });
t("带格式说明", m.content[0].text.includes("格式"), true);
t("带原请求", m.content[0].text.includes("写深度验证脚本"), true);
t("role=user", m.role, "user");
t("source=plugin", m.source.plugin, "dsh-refusal-guard");
const m2 = buildFormatRetryMessage({ fault: "degenerate-repeat", lastRequest: "x" });
t("重复型文案区分", m2.content[0].text.includes("重复"), true);

console.log(fail === 0 ? `r17: ${pass} passed, 0 failed` : `r17: ${pass} passed, ${fail} FAILED`);
process.exit(fail ? 1 : 0);
