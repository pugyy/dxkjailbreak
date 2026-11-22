// 本机宿主源码的文本核对。此脚本不执行或验证运行时行为。
// ok 表示通过现有文本规则，conditional 表示纳入预设的条件分支分类。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
process.env.DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh");
process.env.DSH_SURFACE = process.env.DSH_SURFACE || "desktop";
if (!process.env.DSH_BASE) {
  const la = process.env.LOCALAPPDATA || "";
  const guess = la ? path.join(la, "Programs", "DeepSeek Harness", "resources", "app", "dsh", "node_modules", "@deepseek-ai") : "";
  if (fs.existsSync(guess)) process.env.DSH_BASE = guess;
}

let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log("  ok   " + l); } else { fail++; console.log("  FAIL " + l + (e ? " — " + e : "")); } };

const core = await import(pathToFileUrl(path.join(ROOT, "lib/core.js")));
const all = core.ALL_PATCHES || [];
let map = {};
try { map = core.targetFiles(process.env.DSH_BASE, process.env.DSH_HOME) || {}; } catch {}

function pathToFileUrl(p) { return "file:///" + String(p).replace(/\\/g, "/"); }

const resolveFiles = (p) => {
  const keys = Array.isArray(p.file) ? p.file : (p.file ? [p.file] : []);
  const out = [];
  for (const k of keys) {
    let v = map[k] || map[k + "-nested"] || map[k.replace(/-nested$/, "")];
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v); else out.push(v);
  }
  return [...new Set(out.filter((x) => typeof x === "string" && x && fs.existsSync(x)))];
};

const cat = { ok: 0, na: 0, disabled: 0, obsolete: 0, conditional: 0, residual: 0 };
const residualDetail = [];

// obsolete 名单（定义里带 obsolete 字段或已知设计不打）
const OBSOLETE_IDS = new Set([50, 80, 88]);
// 自定义应用逻辑的条件分支（shared.mjs 的 historical shim 等）
const CONDITIONAL_IDS = new Set([42]);
// 主动关闭（tuning.extraPatches 控制）
const DISABLED_IDS = new Set([18, 19]);

for (const p of all) {
  const reps = Array.isArray(p.replacements) ? p.replacements : [];
  if (!reps.length) continue;

  if (DISABLED_IDS.has(p.id)) { cat.disabled += reps.length; continue; }
  if (OBSOLETE_IDS.has(p.id) || p.obsolete) { cat.obsolete += reps.length; continue; }

  const files = resolveFiles(p);
  if (!files.length) {
    // 目标不存在：silentWhenMissing 的属于 na；否则真问题
    if (p.silentWhenMissing || CONDITIONAL_IDS.has(p.id)) { cat.na += reps.length; continue; }
    cat.residual += reps.length;
    residualDetail.push("#" + p.id + " 目标缺失且非 na");
    continue;
  }

  if (CONDITIONAL_IDS.has(p.id)) {
    // 自定义逻辑补丁：只验证「至少一条 replace 在文件里」（其应用器按宿主形态分支）
    let blob = "";
    for (const f of files) { try { blob += "\n" + fs.readFileSync(f, "utf8"); } catch {} }
    const anyRep = reps.some((r) => {
      const rep = typeof r === "string" ? "" : String(r.replace ?? "");
      return rep && blob.includes(rep);
    });
    if (anyRep) { cat.conditional += reps.length; continue; }
    cat.residual += reps.length;
    residualDetail.push("#" + p.id + " 条件补丁无任何落地痕迹");
    continue;
  }

  let blob = "";
  for (const f of files) { try { blob += "\n" + fs.readFileSync(f, "utf8"); } catch {} }

  for (const r of reps) {
    const pat = typeof r === "string" ? r : r.pattern;
    const rep = typeof r === "string" ? "" : (r.replace ?? "");
    if (!pat) continue;
    const isRe = pat instanceof RegExp;
    let patPresent = false;
    try { patPresent = isRe ? new RegExp(pat.source, pat.flags.replace("g", "")).test(blob) : blob.includes(String(pat)); } catch {}
    const repPresent = rep ? blob.includes(String(rep)) : false;
    if (repPresent || !patPresent) { cat.ok++; continue; }
    cat.residual++;
    residualDetail.push("#" + p.id + " " + String(p.name || "").slice(0, 28) + " 「" + String(isRe ? pat.source : pat).replace(/\n/g, "\\n").slice(0, 56) + "」");
  }
}

console.log("════ 宿主源码静态核对 ════");
const total = cat.ok + cat.na + cat.disabled + cat.obsolete + cat.conditional + cat.residual;
console.log("  已分类 " + total + " 条：通过文本规则 " + cat.ok + " / na " + cat.na + " / disabled " + cat.disabled + " / obsolete " + cat.obsolete + " / conditional " + cat.conditional + " / 残留 " + cat.residual);

ok("通过文本规则的条目 > 140（本机基线）", cat.ok > 140, "实际 " + cat.ok);
ok("文本规则判为残留的条目 = 0", cat.residual === 0, residualDetail.slice(0, 4).join(" | "));
ok("disabled 恰好覆盖 #18/#19（各 1 条）", cat.disabled === 2, "实际 " + cat.disabled);
ok("obsolete 覆盖 #50/#80/#88", cat.obsolete >= 4, "实际 " + cat.obsolete);

if (residualDetail.length) {
  console.log("  残留明细:");
  residualDetail.forEach((d) => console.log("    " + d));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
