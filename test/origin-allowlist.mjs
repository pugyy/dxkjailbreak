// dxkjailbreak · 来源白名单（反代场景）回归
// 覆盖：allowOrigin RPC 的 list/add/remove/clear、白名单文件格式、后端判定顺序、
//       以及「伪造转发头拿不到白名单通道」
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-wl-"));
process.env.DSH_HOME = home;

const mod = await import("file:///" + PKG + "/lib/console-api.js");
let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log("ok   " + l); } else { fail++; console.log("FAIL " + l + (e ? " — " + e : "")); } };

const cfg = path.join(home, "dxkjailbreak", "allowed-origins.txt");

console.log("── allowOrigin RPC ──");
{
  const empty = await mod.allowOrigin("list", {});
  ok("初始为空", empty.ok === true && empty.count === 0, JSON.stringify(empty).slice(0, 100));

  const add = await mod.allowOrigin("add", { origin: "https://dsh.example.com" });
  ok("添加成功", add.ok === true && add.origin === "https://dsh.example.com", JSON.stringify(add).slice(0, 120));
  ok("配置文件已写", fs.existsSync(cfg));
  const body = fs.readFileSync(cfg, "utf8");
  ok("文件含注释头", body.includes("#"));
  ok("文件含该 Origin", body.includes("https://dsh.example.com"));

  const dup = await mod.allowOrigin("add", { origin: "https://dsh.example.com/" });
  ok("重复添加被识别（尾斜杠归一）", dup.ok === true && dup.existed === true, JSON.stringify(dup).slice(0, 100));

  const list = await mod.allowOrigin("list", {});
  ok("list 返回 1 条", list.count === 1 && list.origins[0] === "https://dsh.example.com");

  const withPort = await mod.allowOrigin("add", { origin: "http://127.0.0.1:8080" });
  ok("带端口 Origin 可加", withPort.ok === true && withPort.origins.length === 2, JSON.stringify(withPort.origins));

  const bad = await mod.allowOrigin("add", { origin: "not-a-url" });
  ok("非法 URL 被拒", bad.ok === false && /合法/.test(bad.error), bad.error);
  const ftp = await mod.allowOrigin("add", { origin: "ftp://x.com" });
  ok("非 http(s) 被拒", ftp.ok === false && /http/.test(ftp.error), ftp.error);
  const noArg = await mod.allowOrigin("add", {});
  ok("缺参数被拒", noArg.ok === false);

  const rm = await mod.allowOrigin("remove", { origin: "https://dsh.example.com" });
  ok("移除成功", rm.ok === true && rm.origins.length === 1, JSON.stringify(rm.origins));

  const clr = await mod.allowOrigin("clear", {});
  ok("清空成功", clr.ok === true && clr.origins.length === 0);
  // 只检查「非注释行」——注释头里本来就有 https:// 示例
  const restLines = fs.existsSync(cfg)
    ? fs.readFileSync(cfg, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];
  ok("清空后无生效条目（只留注释）", fs.existsSync(cfg) && restLines.length === 0, restLines.join(" | "));
}

console.log("\n── 请求 Host 与 Origin ──");
{
  const idx = fs.readFileSync(PKG + "/lib/index.js", "utf8");
  const start = idx.indexOf("function webOrigin(");
  const end = idx.indexOf("export function installWebServer", start);
  const configured = new Set(["https://dsh.example.com"]);
  let status;
  const guard = vm.runInNewContext(idx.slice(start, end) + "\nallowPluginRequest;", {
    URL,
    allowedOrigins: () => configured,
    sendJson: (_response, code) => { status = code; },
  });
  const cases = [
    ["桌面允许省略 Origin", { host: "127.0.0.1:3000" }, true],
    ["本机同源通过", { host: "localhost:3000", origin: "http://localhost:3000" }, true],
    ["IPv6 回环通过", { host: "[::1]:3000", origin: "http://[::1]:3000" }, true],
    ["桌面可信同源可使用空来源", { host: "localhost:3000", origin: "null", "sec-fetch-site": "same-origin" }, true],
    ["域名需要预先配置，即使 Origin 和 Host 相等", { host: "unlisted.example", origin: "http://unlisted.example" }, false],
    ["缺少 Host 拒绝", {}, false],
    ["无 Origin 也校验 Host", { host: "unlisted.example" }, false],
    ["跨站请求拒绝", { host: "localhost:3000", "sec-fetch-site": "cross-site" }, false],
    ["异常空来源拒绝", { host: "localhost:3000", origin: "null" }, false],
    ["同站但非同源的无来源请求拒绝", { host: "localhost:3000", "sec-fetch-site": "same-site" }, false],
    ["协议必须一致", { host: "localhost:3000", origin: "https://localhost:3000" }, false],
    ["已配置反代域名通过", { host: "dsh.example.com", origin: "https://dsh.example.com" }, true],
    ["已配置反代可转发至本机 Host", { host: "127.0.0.1:3000", origin: "https://dsh.example.com" }, true],
    ["已配来源也不能替代未知 Host", { host: "unlisted.example", origin: "https://dsh.example.com" }, false],
    ["伪造的转发头不能替代真实 Host", { host: "unlisted.example", "x-forwarded-host": "localhost" }, false],
    ["拒绝带口令的 Origin", { host: "localhost:3000", origin: "http://user@localhost:3000" }, false],
    ["拒绝非回环地址", { host: "0.0.0.0:3000" }, false],
  ];
  for (const [label, headers, expected] of cases) {
    status = undefined;
    const result = guard({ headers, method: "POST", socket: {} }, {});
    ok(label, result === expected && (expected ? status === undefined : status === 403));
  }
}

console.log("\n── 控制台数据库路径 ──");
{
  for (const [api, action] of [[mod.memory, "list"], [mod.trace, "stats"]]) {
    const customFile = path.join(home, "outside.db");
    for (const key of ["dbPath", "db_path"]) {
      const result = await api(action, { [key]: customFile });
      ok("拒绝请求指定 " + key, result.ok === false && /默认数据库/.test(result.error) && !fs.existsSync(customFile));
    }
  }
}

console.log("\n── 前端入口 ──");
{
  const src = fs.readFileSync(PKG + "/client.settings.js", "utf8");
  const cjs = fs.readFileSync(PKG + "/client.js", "utf8");
  ok("门禁页签有白名单区块", /allowlistBlock/.test(src) && /来源白名单（反代）/.test(src));
  ok("区块已挂进 return", /allowlistBlock\]\)/.test(cjs));
  ok("有添加/删除调用", (cjs.match(/allowOrigin/g) || []).length >= 3);
}

fs.rmSync(home, { recursive: true, force: true });
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
