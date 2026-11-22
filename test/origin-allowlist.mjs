// dxkjailbreak · 来源白名单（反代场景）回归
// 覆盖：allowOrigin RPC 的 list/add/remove/clear、白名单文件格式、后端判定顺序、
//       以及「伪造转发头拿不到白名单通道」
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

console.log("\n── 后端判定顺序与转发头 ──");
{
  const idx = fs.readFileSync(PKG + "/lib/index.js", "utf8");
  const i = idx.indexOf("function allowPluginRequest");
  const seg = idx.slice(i, i + 2600);

  ok("白名单判定在 cross-site 硬拒之前",
    seg.indexOf("allowedOrigins().has") > 0 && seg.indexOf("allowedOrigins().has") < seg.indexOf('"cross-site"'),
    "顺序: allow=" + seg.indexOf("allowedOrigins().has") + " cross-site=" + seg.indexOf('"cross-site"'));

  ok("完全不读 x-forwarded-* 转发头", !/x-forwarded/i.test(seg), "仍有引用");
  ok("协议比对用真实连接（socket.encrypted）", /socket\.encrypted|socket\?\.encrypted/.test(seg));
  ok("白名单函数带 mtime 缓存", /mtimeMs/.test(idx.slice(idx.indexOf("function allowedOrigins"), idx.indexOf("function allowedOrigins") + 1200)));
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
