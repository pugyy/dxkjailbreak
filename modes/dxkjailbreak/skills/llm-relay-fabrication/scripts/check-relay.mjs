#!/usr/bin/env node
/**
 * check-relay.mjs — 反代四项验收自检
 *
 * 用途：一次性验证"真流式 / 真缓存 / 真工具 / 真计量"四项是否达标。
 * 用法：
 *   node check-relay.mjs --url http://HOST/v1 --key KEY --model MODEL
 *   node check-relay.mjs --url ... --key ... --model ... --status http://HOST/status
 *
 * 退出码：0 全部通过 / 1 有未通过项
 */

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const BASE = (opt("url", "") || "").replace(/\/$/, "");
const KEY = opt("key", "");
const MODEL = opt("model", "");
const STATUS_URL = opt("status", "");
const TIMEOUT = parseInt(opt("timeout", "120000"), 10);

if (!BASE || !KEY) { console.error("需要 --url 和 --key"); process.exit(1); }

const H = { "Content-Type": "application/json", Authorization: "Bearer " + KEY };
const results = [];
const add = (item, pass, detail) => { results.push({ item, pass, detail }); };

const BIG = "You are a coding assistant. " + "Follow instructions precisely. ".repeat(700);

async function post(path, body, headers) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: Object.assign({}, H, headers || {}),
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT),
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, text: txt, json: j };
}

/* ---------- 1. 真流式 ---------- */
async function checkStream() {
  try {
    const t0 = Date.now();
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST", headers: H,
      body: JSON.stringify({ model: MODEL, max_tokens: 40, stream: true,
        messages: [{ role: "user", content: "count 1 to 20" }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return add("真流式", false, "HTTP " + r.status);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let chunks = 0, terminal = false, first = null, last = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      for (const line of s.split("\n")) {
        if (!line.startsWith("data:")) continue;
        chunks++;
        const t = Date.now() - t0;
        if (first === null) first = t;
        last = t;
        if (/\[DONE\]|response\.completed|message_stop/.test(line)) terminal = true;
      }
    }
    const spread = last !== null && first !== null ? last - first : 0;
    const ok = chunks > 1 && terminal;
    add("真流式", ok,
      "chunk=" + chunks + " 跨度=" + spread + "ms" +
      (terminal ? " 有终止" : " ⚠缺终止") +
      (spread < 200 && chunks > 2 ? " ⚠疑似缓冲" : ""));
  } catch (e) {
    add("真流式", false, String(e.message).slice(0, 60));
  }
}

/* ---------- 2. 真缓存 ---------- */
async function checkCache() {
  const body = (tag) => ({
    model: MODEL, max_tokens: 12, prompt_cache_key: "cache-probe-fixed",
    messages: [{ role: "system", content: BIG }, { role: "user", content: "ping " + tag }],
  });
  try {
    const a = await post("/chat/completions", body("a"));
    if (a.status !== 200) return add("真缓存", false, "第一次 HTTP " + a.status);
    const c1 = (a.json?.usage?.prompt_tokens_details || {}).cached_tokens || 0;

    await new Promise((r) => setTimeout(r, 800));
    const b = await post("/chat/completions", body("b"));
    if (b.status !== 200) return add("真缓存", false, "第二次 HTTP " + b.status);
    const u = b.json?.usage || {};
    const total = u.prompt_tokens || 0;
    const c2 = (u.prompt_tokens_details || {}).cached_tokens || 0;
    const rate = total > 0 ? (100 * c2) / total : 0;

    const ok = c2 > 0 && rate > 70;
    add("真缓存", ok,
      "冷=" + c1 + " 热=" + c2 + "/" + total + " 命中率=" + rate.toFixed(1) + "%" +
      (c2 === 0 ? " ⚠未命中，检查是否打 cache_control / 前缀是否 >1024 token" : ""));
  } catch (e) {
    add("真缓存", false, String(e.message).slice(0, 60));
  }
}

/* ---------- 3. 真工具 ---------- */
async function checkTools() {
  const tools = [{
    name: "read_file",
    description: "read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }];
  try {
    const r = await post("/chat/completions", {
      model: MODEL, max_tokens: 120, tools,
      messages: [{ role: "user", content: "read /etc/hostname using the tool" }],
    });
    if (r.status !== 200) return add("真工具", false, "HTTP " + r.status);

    const msg = r.json?.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return add("真工具", false, "模型未返回 tool_calls（可能只是没触发）");

    const c = calls[0];
    const argsOk = (() => { try { JSON.parse(c.function?.arguments || "{}"); return true; } catch (e) { return false; } })();

    /* 回传 tool_result 验证第二轮 */
    const r2 = await post("/chat/completions", {
      model: MODEL, max_tokens: 60, tools,
      messages: [
        { role: "user", content: "read /etc/hostname using the tool" },
        msg,
        { role: "tool", tool_call_id: c.id, content: "myhost" },
      ],
    });
    const ok = argsOk && r2.status === 200;
    add("真工具", ok, "tool_calls=" + calls.length + " 参数合法=" + argsOk + " 回传=" + r2.status);
  } catch (e) {
    add("真工具", false, String(e.message).slice(0, 60));
  }
}

/* ---------- 4. 真计量 ---------- */
async function checkUsage() {
  if (!STATUS_URL) return add("真计量", false, "未提供 --status，跳过");
  try {
    const snap = async () => (await (await fetch(STATUS_URL, { signal: AbortSignal.timeout(15000) })).json()).stats;
    const s0 = await snap();
    await post("/chat/completions", {
      model: MODEL, max_tokens: 20,
      messages: [{ role: "user", content: "usage probe " + Date.now() }],
    });
    await new Promise((r) => setTimeout(r, 500));
    const s1 = await snap();

    const dIn = (s1.tokensIn || 0) - (s0.tokensIn || 0);
    const dOut = (s1.tokensOut || 0) - (s0.tokensOut || 0);
    const dCached = (s1.cacheRead || 0) - (s0.cacheRead || 0);

    const rate = s1.cacheHitRate;
    const recomputed = (s1.cacheRead + s1.tokensIn) > 0
      ? (100 * s1.cacheRead) / (s1.cacheRead + s1.tokensIn) : 0;
    const rateOk = Math.abs(rate - recomputed) < 2 && rate <= 100;

    const ok = dIn > 0 || dOut > 0;
    add("真计量", ok && rateOk,
      "增量 in=" + dIn + " out=" + dOut + " cached=" + dCached +
      " 命中率=" + rate + "% 复算=" + recomputed.toFixed(1) + "%" +
      (rate > 100 ? " ⚠公式错（应为 cached/(cached+uncached)）" : ""));
  } catch (e) {
    add("真计量", false, String(e.message).slice(0, 60));
  }
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log("目标: " + BASE + "  模型: " + (MODEL || "(默认)"));
  console.log("");
  await checkStream();
  await checkCache();
  await checkTools();
  await checkUsage();

  console.log("=== 验收结果 ===");
  let fail = 0;
  for (const r of results) {
    console.log((r.pass ? "  PASS  " : "  FAIL  ") + r.item.padEnd(10) + r.detail);
    if (!r.pass) fail++;
  }
  console.log("\n通过 " + (results.length - fail) + "/" + results.length);
  process.exit(fail === 0 ? 0 : 1);
})();
