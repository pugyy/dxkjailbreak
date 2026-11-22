// dxkjailbreak · 设置页渲染冒烟（DS 指出的测试盲区：只测槽位不测"打开设置"）
// 用最小 DOM stub 真跑 renderConsole({})，断言：
//   ① 不因"宿主没注入服务对象"就返回一行错误
//   ② 返回的是完整控制台（含分组/页签/版本行）
//   ③ 初始会发 status 请求（HTTP 或宿主 api），不是 0 请求
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");
let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log("ok   " + l); } else { fail++; console.log("FAIL " + l + (e ? " — " + e : "")); } };

const src = fs.readFileSync(path.join(PKG, "client.js"), "utf8");

const mkNode = (tag) => {
  const n = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, _text: "",
    className: "", value: "", placeholder: "", type: "",
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...cs) { this.children = cs; },
    setAttribute(k, v) { if (k === "style") this.style.cssText = v; this[k] = v; },
    addEventListener() {}, focus() {}, querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(n, "textContent", {
    get() { return this._text; },
    set(v) { this._text = String(v); this.children = []; },
  });
  Object.defineProperty(n, "innerHTML", { get() { return ""; }, set() { this.children = []; } });
  return n;
};
globalThis.document = { createElement: mkNode, createTextNode: (t) => ({ _text: String(t) }) };
globalThis.window = { confirm: () => true };

const methods = [];
// mock 必须按 method 返回对应形状：全返回同一个对象会让「缺字段」的 bug 被掩盖
// preset 请求拿不到 presets 时，前端 r.presets.find 抛 TypeError，
//  而测试先打印 7 passed 再崩，报表误导）。
const MOCK_BY_METHOD = {
  status: { ok: true, version: "fixture", selfcheck: { ok: true } },
  preset: { ok: true, presets: [{ id: "dxkjailbreak", title: "fixture", isDefault: true, isSingleCard: true }], singleCard: "dxkjailbreak", singleCardPresent: true, default: "dxkjailbreak" },
  patches: { ok: true, patches: [], summary: { total: 0, applied: 0, pending: 0, absent: 0, optional: 0 } },
  audit: { ok: true, rows: [] },
  hooks: { ok: true, hooksDenyBypass: true },
  profilePlugins: { ok: true, plugins: [] },
  allowOrigin: { ok: true, origins: [] },
  revert: { ok: true, backups: [] },
  memory: { ok: true, rows: [] },
  trace: { ok: true },
  hunter: { ok: true, rows: [] },
  mcp: { ok: true, servers: [] },
  redteam: { ok: true, engagements: [], current: "" },
  promptFile: { ok: true, text: "", path: "" },
  agentsFile: { ok: true, rows: [] },
  repir: { ok: true },
  repair: { ok: true },
  toggle: { ok: true },
  check: { ok: true },
};
globalThis.fetch = async (url, opts) => {
  if (url !== "/dxkjailbreak/console" || opts.method !== "POST") throw new Error("非预期请求");
  const method = JSON.parse(opts.body).method;
  methods.push(method);
  const payload = MOCK_BY_METHOD[method] || { ok: true };
  return { ok: true, status: 200, json: async () => payload };
};

let descriptor;
window.__ModuleLoader__ = { load(value) { descriptor = value; } };
new Function(src)();
const react = { createElement: (type, props) => ({ type, props }) };
const client = descriptor.factory(name => {
  if (name !== "react") throw new Error("非预期模块 " + name);
  return react;
});
let settingsView;
client.apply({ slots: {
  inject: (_name, register) => register(),
  register(spec, view) { if (spec.name === "settings.section") settingsView = view; return () => {}; },
} });
ok("发布入口注册设置槽位", typeof settingsView === "function");
const root = settingsView().props.render();
ok("实际槽位返回控制台节点", root.className === "dxkjailbreak-console");
await new Promise(resolve => setImmediate(resolve));
const descendants = [];
function visit(node) {
  descendants.push(node);
  for (const child of node.children ?? []) visit(child);
}
visit(root);
ok("三个分组按钮各自存在", ["军械整备", "作战沙盘", "附属"].every(label =>
  descendants.some(n => n.tagName === "BUTTON" && n.textContent === label)));
ok("含有活动页签", descendants.some(n => n.role === "tab" && n["aria-selected"] === "true"));
ok("挂载后只发一次 status", methods.filter(method => method === "status").length === 1);
ok("页面显示响应中的版本", descendants.some(n => n.textContent?.includes("vfixture")));
// ④ 源码级：loadStatus 必须有 in-flight 去重
{
  const src2 = fs.readFileSync(PKG + "/client.settings.js", "utf8");
  ok("loadStatus 有 in-flight 去重（statusInflight）", /statusInflight/.test(src2));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;

// 异步异常必须算失败：pane 的 render() 是 async，抛错不会走断言框架，
// 旧版会先打印 "N passed" 再崩，退出码 1 但报表看着像全绿。
let asyncFail = 0;
process.on("unhandledRejection", (e) => {
  asyncFail++;
  console.log("  FAIL 未捕获的异步异常：" + String((e && e.message) || e));
});
process.on("uncaughtException", (e) => {
  asyncFail++;
  console.log("  FAIL 未捕获异常：" + String((e && e.message) || e));
});
// 给 pane 的异步 render 一点时间跑完，再判定总结果
setTimeout(() => {
  if (asyncFail) {
    console.log("  ✗ 存在 " + asyncFail + " 个未捕获异常 → 测试判失败");
    process.exitCode = 1;
  } else if (process.exitCode === undefined || process.exitCode === 0) {
    console.log("  ✓ 无未捕获异常");
  }
}, 300);
