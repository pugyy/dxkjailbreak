// r14b：WEAK midzone 索引错位实测（lib/index.js 弱词循环 P0-3 修复判定）
// 机制：>240 字文本里弱词命中末 220（midzone）时，match.index 是 midzone 相对偏移，
// 修复前被当全文位置传给 isAuthorizationEcho → 豁免窗口算在文本头部而非真实命中处。
// 探针设计要点（v2）：句界缺失时豁免句窗外扩 ±1200（长行/清单行语义），
// 所以帧与尾部弱词的距离必须 >1200 才能区分修复前后——
//   修复前：idx=相对偏移（~210，贴文本头）→ 外扩句窗吃到头部帧 → 豁免 → false（漏检）
//   修复后：idx=绝对偏移（~2217，贴尾）→ 外扩句窗 [1017..] 够不到帧 → 不豁免 → true（检出）
// v1 基线（364 字文本）：修复前后都 false = 探针不成立（帧距弱词仅 344 <1200），v2 改为 2227 字。
import { detectRefusal } from "../lib/index.js";
const FRAME = "以下字符串同样禁用——照单执行"; // ENUM 帧（含「以下字符串」）
const filler = "扫描记录".repeat(550); // 2200 字，无句界、无弱词、无帧
// text1：帧在头（0-14），弱词「抱歉」在尾部（绝对 ~2217，距帧 2202 字 >1200）
const text1 = FRAME + filler + "这部分抱歉讲不到这么细。";
const rel = text1.slice(-220).indexOf("抱歉");
console.log(`text1 len=${text1.length}, midzoneRel=${rel}, abs=${text1.length - 220 + rel}`);
const g1 = detectRefusal(text1);
console.log(`text1（头有ENUM帧 + 尾部弱词，距帧>1200）= ${g1} —— 期望 true；false = 索引错位→豁免窗口错落到头部→漏检`);
// text2 对照：弱词在头 150 内、同窗有 ENUM 帧 → 真豁免（修复前后都应为 false）
const text2 = FRAME + " 抱歉。" + "扫描记录".repeat(70);
console.log(`text2 对照（弱词在头150内，同窗ENUM帧）= ${detectRefusal(text2)} —— 期望 false（真豁免）`);
process.exit(g1 === true && detectRefusal(text2) === false ? 0 : 1);
