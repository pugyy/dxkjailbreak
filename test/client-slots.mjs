// dxkjailbreak · client.js 槽位注册回归（不需要真实宿主）
// 断言：ModuleLoader 格式 / 导出形状 / 两个槽位注册 / 无旧的 globalThis 猜测 API / 卸载清理钩子
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const src = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra ? " — " + extra : "")); }
};

// ── 静态断言 ──
ok("ModuleLoader 格式", src.includes("window.__ModuleLoader__.load({"));
ok("包 id = dxkjailbreak", src.includes('id: "dxkjailbreak"'));
ok("用宿主槽位 API（slots.inject）", src.includes('slots.inject("settings.section"') && src.includes('slots.inject("conversation.view"'));
ok("不再依赖 globalThis 猜测式注册", !src.includes("findSettingsHost")) ;
ok("会话标签名", src.includes('label: function () { return "独立团指挥部"; }'));
ok("会话标签 order 54", /id: "duk-li-tuan-hq",\s*\n\s*order: 54/.test(src));
ok("设置分区 id = dxkjailbreak", /name: "settings.section",\s*\n\s*id: "dxkjailbreak"/.test(src));
ok("React 桥存在", src.includes("function DomBridge") && src.includes("__dxkDispose"));
ok("三组页签", ["军械整备", "作战沙盘", "附属"].every((g) => src.includes(g + ":")));
// 授权契约：走本机同源 HTTP（服务端 Origin 栅栏挡跨站），且**不**暴露公开凭据端点。
// （旧断言要求入口先返回"未提供接口"——那会让整个设置页只剩一行错误，已废弃。）
ok("控制台走同源 HTTP 且无公开凭据端点",
  src.includes("/dxkjailbreak/console") && !src.includes("/dxkjailbreak/token"));
ok("请求失败时给出可读错误（不是静默）",
  /控制台请求失败（HTTP /.test(src) || /读取失败：/.test(src));
ok("无旧术语残留（演练台/魅魔安全管理）", !src.includes("演练台") && !src.includes("魅魔安全管理"));

// ── 运行期断言：模拟宿主 ──
let def = null;
globalThis.window = { __ModuleLoader__: { load: (d) => { def = d; } } };
const React = {
  createElement: (t, p) => ({ t, p }),
  useRef: () => ({ current: null }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
};
globalThis.document = {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, children: [] }),
  createTextNode: () => ({}),
};
try {
  (0, eval)(src);
  ok("eval 加载成功", !!def && def.id === "dxkjailbreak");
  const mod = def.factory((n) => { if (n === "react") return React; throw new Error("unexpected require " + n); });
  ok("导出 name", mod.name === "dxkjailbreak-client");
  ok("inject 含 slots", Array.isArray(mod.inject) && mod.inject.includes("slots"));
  ok("apply 是函数", typeof mod.apply === "function");

  const calls = [];
  const ctx = {
    slots: {
      inject: (slot, fn) => { calls.push("inject:" + slot); return fn(); },
      register: (spec) => { calls.push("register:" + spec.name + ":" + spec.label() + "@" + spec.order); return () => {}; },
    },
  };
  mod.apply(ctx);
  ok("注册 settings.section", calls.includes("inject:settings.section") && calls.some((c) => c.startsWith("register:settings.section:dxkjailbreak@")));
  ok("注册 conversation.view", calls.includes("inject:conversation.view") && calls.some((c) => c.startsWith("register:conversation.view:独立团指挥部@54")));
  ok("注册顺序：设置在前", calls.indexOf("inject:settings.section") < calls.indexOf("inject:conversation.view"));
} catch (e) {
  fail++;
  console.log("FAIL 运行期异常 — " + e.message);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
