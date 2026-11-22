import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVO = path.join(HERE, "..", "evolution");
const LOG = path.join(EVO, "LOG.md");
const RULES = path.join(EVO, "RULES.md");
const STATE = path.join(EVO, "STATE.json");

fs.mkdirSync(EVO, { recursive: true });

const TAGS = ["probe", "model", "auth", "protocol", "stream", "cache", "usage", "sched", "retry", "ops", "risk", "other"];

function clean(s) {
  return String(s || "")
    .replace(/\n-{3,}\s*$/g, "")
    .replace(/\n+---+\s*$/g, "")
    .replace(/^\s*[-—]+\s*$/gm, "")
    .trim();
}

function parseLog() {
  if (!fs.existsSync(LOG)) return [];
  const txt = fs.readFileSync(LOG, "utf8");
  const blocks = txt.split(/\n(?=## )/).filter((b) => b.startsWith("## "));
  const items = [];
  for (const b of blocks) {
    const head = (/^## (.+)$/m.exec(b) || [])[1] || "";
    /* 跳过模板与说明块 */
    if (/模板|示例|说明/.test(head)) continue;

    const grab = (field) => {
      const re = new RegExp("\\*\\*" + field + "\\*\\*[:：]\\s*([\\s\\S]*?)(?=\\n\\*\\*[^*]+\\*\\*[:：]|\\n## |\\n---|$)", "i");
      const m = re.exec(b);
      return m ? clean(m[1]) : "";
    };

    const ruleRaw = grab("规则");
    const tagMatch = /^\s*\[([a-z]+)\]/i.exec(ruleRaw);
    const tag = tagMatch && TAGS.includes(tagMatch[1].toLowerCase()) ? tagMatch[1].toLowerCase() : "other";
    const rule = ruleRaw.replace(/^\s*\[[a-z]+\]\s*/i, "").trim();

    /* 规则为空或仍是占位符 → 不算有效条目 */
    if (!rule || /^<.*>$/.test(rule)) continue;

    items.push({
      title: head.replace(/^[\d\-:\s]+/, "").replace(/·\s*/, "").trim(),
      symptom: grab("症状"),
      root: grab("根因"),
      evidence: grab("证据"),
      rule, tag,
      detect: grab("检测").replace(/`/g, "").replace(/\s+/g, " ").trim(),
    });
  }
  return items;
}

function compile() {
  const items = parseLog();
  const byTag = {};
  for (const it of items) (byTag[it.tag] = byTag[it.tag] || []).push(it);

  const lines = [
    "# 硬规则（自动生成，勿手改）",
    "",
    "> 由 `node scripts/evolve.mjs compile` 从 LOG.md 编译。",
    "> 生成时间：" + new Date().toISOString(),
    "> 规则总数：" + items.length,
    "",
  ];

  let n = 0;
  for (const tag of TAGS) {
    const arr = byTag[tag];
    if (!arr || !arr.length) continue;
    lines.push("## " + tag.toUpperCase() + "（" + arr.length + " 条）", "");
    for (const it of arr) {
      n++;
      lines.push("### R-" + String(n).padStart(2, "0") + " [" + tag + "] " + it.title);
      if (it.symptom) lines.push("- **症状**：" + it.symptom.replace(/\n/g, " "));
      if (it.root) lines.push("- **根因**：" + it.root.replace(/\n/g, " "));
      lines.push("- **规则**：" + it.rule.replace(/\n/g, " "));
      if (it.detect) lines.push("- **检测**：`" + it.detect + "`");
      if (it.evidence) lines.push("- **证据**：" + it.evidence.replace(/\n/g, " ").slice(0, 200));
      lines.push("");
    }
  }

  fs.writeFileSync(RULES, lines.join("\n"), "utf8");
  fs.writeFileSync(STATE, JSON.stringify({
    compiledAt: new Date().toISOString(),
    ruleCount: items.length,
    byTag: Object.fromEntries(Object.entries(byTag).map(([k, v]) => [k, v.length])),
  }, null, 2), "utf8");

  console.log("已编译 " + items.length + " 条规则 → RULES.md\n");
  for (const tag of TAGS) {
    const arr = byTag[tag];
    if (arr && arr.length) console.log("  " + tag.padEnd(10) + arr.length + " 条");
  }
}

function check() {
  if (!fs.existsSync(RULES)) { console.log("还没编译，先跑 compile"); return; }
  const txt = fs.readFileSync(RULES, "utf8");
  const rules = txt.split(/\n(?=### R-)/).filter((b) => b.startsWith("### R-"));
  console.log("=== 开工前自检清单（" + rules.length + " 条）===\n");
  for (const r of rules) {
    const head = /^### (R-\d+) \[([a-z]+)\] (.+)$/m.exec(r);
    const detect = (/\*\*检测\*\*：`(.+?)`/.exec(r) || [])[1] || "";
    console.log("[ ] " + (head ? head[1] + " [" + head[2] + "] " + head[3] : "?"));
    if (detect) console.log("      验证 → " + detect);
  }
  console.log("\n逐条打勾，未通过的不许开工。");
}

function stats() {
  if (!fs.existsSync(STATE)) { console.log("还没编译"); return; }
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  console.log("规则总数: " + s.ruleCount);
  console.log("编译时间: " + s.compiledAt);
  for (const [k, v] of Object.entries(s.byTag || {})) console.log("  " + k.padEnd(10) + v);
}

function add() {
  const tpl = "\n## " + new Date().toISOString().slice(0, 10) + " · <一句话标题>\n\n**症状**：\n**根因**：\n**证据**：\n**规则**：[tag] \n**检测**：\n";
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "# 进化日志\n", "utf8");
  fs.appendFileSync(LOG, tpl, "utf8");
  console.log("已追加模板，填完五个字段后跑 compile");
}

const cmd = process.argv[2] || "stats";
({ compile, check, stats, add })[cmd] ? ({ compile, check, stats, add })[cmd]() : stats();
