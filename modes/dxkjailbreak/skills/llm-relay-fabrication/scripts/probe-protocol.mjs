#!/usr/bin/env node
/**
 * probe-protocol.mjs — 通用协议嗅探器
 *
 * 用途：对任意 AI 网关/中转的同一个 URL 发 5 种协议的请求，判定它支持哪些。
 * 用法：
 *   node probe-protocol.mjs --url http://HOST/v1 --key KEY --model MODEL
 *   node probe-protocol.mjs --url http://HOST/v1 --key KEY --model MODEL --stream
 *
 * 输出：每种协议的状态码 + 耗时 + 响应片段，以及支持矩阵。
 */

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = (opt("url", "http://127.0.0.1:7799") || "").replace(/\/$/, "");
const KEY = opt("key", "");
const MODEL = opt("model", "");
const STREAM = args.includes("--stream");
const TIMEOUT = parseInt(opt("timeout", "90000"), 10);

if (!KEY) {
  console.error("必须提供 --key");
  process.exit(1);
}

const H = { "Content-Type": "application/json", Authorization: "Bearer " + KEY };

/* ---------- 五种协议的请求体 ---------- */
const CASES = [
  {
    name: "OpenAI Chat",
    path: "/chat/completions",
    body: { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "say OK" }] },
    detect: (j) => !!j.choices,
  },
  {
    name: "OpenAI Responses",
    path: "/responses",
    body: { model: MODEL, input: [{ role: "user", content: "say OK" }], max_output_tokens: 16 },
    detect: (j) => !!j.output || !!j.object,
  },
  {
    name: "Anthropic",
    path: "/messages",
    body: { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "say OK" }] },
    headers: { "anthropic-version": "2023-06-01", "x-api-key": KEY },
    detect: (j) => !!j.content,
  },
  {
    name: "Gemini",
    path: "/beta/models/" + (MODEL || "m") + ":generateContent",
    body: { contents: [{ parts: [{ text: "say OK" }] }] },
    detect: (j) => !!j.candidates,
  },
  {
    name: "Ollama",
    path: "/../api/chat",
    body: { model: MODEL, messages: [{ role: "user", content: "say OK" }], stream: false },
    detect: (j) => !!j.message,
  },
];

/* ---------- 探测 ---------- */
async function probe(c) {
  const url = BASE + c.path;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({}, H, c.headers || {}),
      body: JSON.stringify(c.body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    const ok = r.ok && j && c.detect(j);
    return { name: c.name, status: r.status, ms, ok, body: txt.slice(0, 140).replace(/\s+/g, " ") };
  } catch (e) {
    return { name: c.name, status: "ERR", ms: Date.now() - t0, ok: false, body: String(e.message).slice(0, 80) };
  }
}

/* ---------- 流式探测 ---------- */
async function probeStream() {
  const t0 = Date.now();
  const stamps = [];
  try {
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST", headers: H,
      body: JSON.stringify({ model: MODEL, max_tokens: 40, stream: true,
        messages: [{ role: "user", content: "count from 1 to 20" }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return { status: r.status, chunks: 0, note: "非 200" };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", terminal = false, chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (line.startsWith("data:")) {
          chunks++;
          stamps.push(Date.now() - t0);
          if (line.includes("[DONE]") || line.includes("response.completed") || line.includes("message_stop")) terminal = true;
        }
      }
      buf = "";
    }
    const spread = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
    return { status: 200, chunks, terminal, spread, note: spread > 300 ? "真流式" : "疑似缓冲后一次性发出" };
  } catch (e) {
    return { status: "ERR", chunks: 0, note: String(e.message).slice(0, 60) };
  }
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log("目标: " + BASE);
  console.log("模型: " + (MODEL || "(未指定)"));
  console.log("");

  const results = [];
  for (const c of CASES) {
    const r = await probe(c);
    results.push(r);
    const mark = r.ok ? "✓" : "✗";
    console.log(
      mark + " " + r.name.padEnd(18) + String(r.status).padEnd(6) +
      String(r.ms + "ms").padEnd(9) + r.body.slice(0, 70)
    );
  }

  if (STREAM) {
    console.log("\n=== 流式 ===");
    const s = await probeStream();
    console.log("  状态 " + s.status + "  chunk数 " + s.chunks +
      (s.terminal ? "  有终止事件" : "  ⚠无终止事件") +
      (s.spread !== undefined ? "  跨度 " + s.spread + "ms" : "") +
      "  → " + s.note);
  }

  const supported = results.filter((r) => r.ok).map((r) => r.name);
  console.log("\n=== 支持矩阵 ===");
  console.log("  支持 " + supported.length + "/" + CASES.length + ": " + (supported.join(", ") || "无"));
  console.log("\n判定依据是响应体结构，不是状态码 —— 200 但结构不对也算不支持。");
})();
