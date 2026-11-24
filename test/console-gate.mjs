// dxkjailbreak · 控制台 origin 门运行时回归（审计 F2/F6/F7/F13）
// 驱动真实 lib/index.js 的 installWebServer，用假 ctx 收集 /dxkjailbreak/console 路由，
// 直接灌不同 Origin/Host/sec-fetch-site 组合的 POST，断言门禁行为。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-gate-"));
process.env.DSH_HOME = home;
process.env.DSH_PROFILE = "desktop";

const mod = await import(pathToFileURL(path.join(PKG, "lib", "index.js")).href);

const routes = new Map();
const ctx = {
  inject: (names, fn) => {
    const host = {
      effect: (f) => f(),
      webServer: { register: (spec) => { routes.set(spec.path, spec.handler); return () => {}; } },
    };
    fn(host);
  },
  get: () => null,
  on: () => {},
};
mod.installWebServer(ctx, { enabled: true });

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra ? " — " + extra : "")); }
};

const consoleRoute = routes.get("/dxkjailbreak/console");
ok("console 路由已注册", typeof consoleRoute === "function");

async function call(body, headers = {}) {
  const request = {
    method: "POST",
    url: "/dxkjailbreak/console",
    headers,
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  let code = 0, payload = null;
  const response = {
    writeHead: (c) => { code = c; },
    end: (d) => { payload = d ? JSON.parse(d) : null; },
  };
  try { await consoleRoute(request, response); } catch { /* 路由自身异常按 500 记 */ }
  return { code: code || 500, payload };
}

const LOCAL = { host: "127.0.0.1:5495", origin: "http://127.0.0.1:5495" };
const PUBLIC = { host: "hq.example.com", origin: "http://hq.example.com" };

console.log("── 栅栏（跨站一票否决）──");
{
  const r = await call({ method: "status" }, { host: LOCAL.host, origin: "http://evil.example", "sec-fetch-site": "cross-site" });
  ok("跨站请求栅栏 403", r.code === 403, JSON.stringify(r).slice(0, 120));
}

console.log("\n── F2 写操作 origin 门 ──");
{
  // 先经 loopback 把公网源加进白名单——之后"剥掉 Origin 的代理读请求"才能过栅栏，
  // 才能测到 F2 门本身（无 Origin + 公网 Host 的写在栅栏之后被门 403）。
  const add = await call({ method: "allowOrigin", args: ["add", { origin: PUBLIC.origin }] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("loopback 添加白名单成功", add.code === 200 && add.payload?.ok === true, JSON.stringify(add).slice(0, 120));
  const file = path.join(home, "dxkjailbreak", "allowed-origins.txt");
  ok("白名单文件已落盘", fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(PUBLIC.origin));

  const read = await call({ method: "status" }, { host: PUBLIC.host, "sec-fetch-site": "none" });
  ok("白名单代理无 Origin 读放行", read.code === 200, JSON.stringify(read).slice(0, 120));
  const write = await call({ method: "hooks", args: ["set", { hooksDenyBypass: true }] }, { host: PUBLIC.host, "sec-fetch-site": "none" });
  ok("白名单代理无 Origin 写 403（F2 门）", write.code === 403 && /Origin/.test(String(write.payload?.error || "")), JSON.stringify(write).slice(0, 120));

  const cli = await call({ method: "hooks", args: ["set", { hooksDenyBypass: true }] }, { host: LOCAL.host });
  ok("loopback 无 Origin 写放行（本地 CLI）", cli.code === 200, JSON.stringify(cli).slice(0, 120));
  const ui = await call({ method: "hooks", args: ["set", { hooksDenyBypass: true }] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("本机带 Origin 写放行", ui.code === 200, JSON.stringify(ui).slice(0, 120));
}

console.log("\n── F7 白名单变更只许 loopback ──");
{
  const file = path.join(home, "dxkjailbreak", "allowed-origins.txt");
  const remote = await call({ method: "allowOrigin", args: ["remove", { origin: PUBLIC.origin }] }, { host: PUBLIC.host, origin: PUBLIC.origin, "sec-fetch-site": "same-origin" });
  ok("公网改白名单 403（F7 门）", remote.code === 403 && /loopback/.test(String(remote.payload?.error || "")), JSON.stringify(remote).slice(0, 160));
  ok("公网未动白名单文件", fs.readFileSync(file, "utf8").includes(PUBLIC.origin));
  const list = await call({ method: "allowOrigin", args: ["list"] }, { host: PUBLIC.host, origin: PUBLIC.origin, "sec-fetch-site": "same-origin" });
  ok("公网读白名单放行", list.code === 200, JSON.stringify(list).slice(0, 120));
  const rm = await call({ method: "allowOrigin", args: ["remove", { origin: PUBLIC.origin }] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("loopback 移除白名单成功", rm.code === 200, JSON.stringify(rm).slice(0, 120));
}

console.log("\n── F13 content-length 预检 ──");
{
  const r = await call({ method: "status" }, { host: LOCAL.host, "content-length": String(99 * 1024 * 1024) });
  ok("超限额声明直接拒 413（不吃完缓冲）", r.code === 413 && /too large/i.test(String(r.payload?.error || "")), JSON.stringify(r).slice(0, 120));
}

console.log("\n── F6 停用后只留 toggle ──");
{
  fs.mkdirSync(path.join(home, "dxkjailbreak"), { recursive: true });
  fs.writeFileSync(path.join(home, "dxkjailbreak", "console.json"), JSON.stringify({ enabled: false }, null, 2) + "\n");
  const read = await call({ method: "status" }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("停用后读仍放行", read.code === 200, JSON.stringify(read).slice(0, 120));
  const write = await call({ method: "hooks", args: ["set", { hooksDenyBypass: false }] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("停用后写 403（disabled 标记）", write.code === 403 && write.payload?.disabled === true, JSON.stringify(write).slice(0, 120));
  const tog = await call({ method: "toggle", args: [true] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("停用后 toggle 放行（重新启用通道）", tog.code === 200, JSON.stringify(tog).slice(0, 160));
  const again = await call({ method: "hooks", args: ["set", { hooksDenyBypass: false }] }, { host: LOCAL.host, origin: LOCAL.origin });
  ok("重新启用后写恢复", again.code === 200, JSON.stringify(again).slice(0, 120));
}

fs.rmSync(home, { recursive: true, force: true });
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
