// dxkjailbreak · 工作区配置与规则编辑器回归
// 覆盖：setWorkspace 设定/清除/校验、workspace scope 出现与读写、preset 不再处理该动作、
//       前端 hqCall 无悬空依赖、save 前作用域一致性守卫
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-ws-"));
process.env.DSH_HOME = home;

const mod = await import(pathToFileURL(path.join(PKG, "lib", "console-api.js")).href);
if (mod.CONSOLE_VERSION !== JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version) {
  throw new Error("控制台 API 版本与发布清单不一致");
}
let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log("ok   " + l); } else { fail++; console.log("FAIL " + l + (e ? " — " + e : "")); } };

console.log("── setWorkspace ──");
const target = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-proj-"));
{
  const r1 = await mod.agentsFile("setWorkspace", { path: target });
  ok("设定成功", r1 && r1.ok === true, JSON.stringify(r1).slice(0, 120));
  ok("回显路径正确", r1 && path.resolve(r1.workspace) === path.resolve(target), r1 && r1.workspace);

  const cfg = path.join(home, "dxkjailbreak", "workspace.txt");
  ok("workspace.txt 已写入", fs.existsSync(cfg));
  ok("内容为绝对路径", fs.existsSync(cfg) && path.isAbsolute(fs.readFileSync(cfg, "utf8").trim()));

  const list = await mod.agentsFile("list", {});
  ok("list 含 workspace scope", (list.rows || []).some((r) => r.scope === "workspace"),
    JSON.stringify((list.rows || []).map((r) => r.scope)));

  const rd = await mod.agentsFile("read", { scope: "workspace" });
  ok("read workspace 正常", rd.ok === true, rd.error);

  const wr = await mod.agentsFile("save", { scope: "workspace", text: "# 项目规矩\n测试\n" });
  ok("save workspace 成功", wr.ok === true, wr.error);
  ok("文件落在工作区目录", fs.existsSync(path.join(target, "AGENTS.md")));

  const file = path.join(target, "AGENTS.md");
  fs.writeFileSync(file, "");
  const empty = await mod.agentsFile("list");
  ok("零字节文件仍显示已创建", empty.rows.some(row => row.scope === "workspace" && row.exists && row.size === 0));
  const snapshot = await mod.agentsFile("read", { scope: "workspace" });
  fs.writeFileSync(file, "external edit");
  const stale = await mod.agentsFile("save", { scope: "workspace", revision: snapshot.revision, text: "stale" });
  ok("保留外部编辑", !stale.ok && fs.readFileSync(file, "utf8") === "external edit");
  const prior = await mod.agentsFile("read", { scope: "workspace" });
  const other = path.join(target, "other");
  fs.mkdirSync(other);
  const otherFile = path.join(other, "AGENTS.md");
  fs.writeFileSync(otherFile, "external edit");
  await mod.agentsFile("setWorkspace", { path: other });
  const moved = await mod.agentsFile("save", { scope: "workspace", revision: prior.revision, text: "stale" });
  ok("相同正文的不同工作区也能识别", !moved.ok && fs.readFileSync(otherFile, "utf8") === "external edit");
  for (const value of ["first", "second"]) {
    const current = await mod.agentsFile("read", { scope: "workspace" });
    const saved = await mod.agentsFile("save", { scope: "workspace", revision: current.revision, text: value });
    ok("正常保存 " + value, saved.ok && fs.readFileSync(otherFile, "utf8") === value);
  }
  const backups = fs.readdirSync(other).filter(name => name.startsWith("AGENTS.md.bak-"));
  ok("连续保存留下两份独立备份", backups.length === 2);
  fs.unlinkSync(cfg);
  fs.mkdirSync(cfg);
  const refused = await mod.agentsFile("setWorkspace", { path: "" });
  ok("清除失败向界面返回错误", !refused.ok && fs.statSync(cfg).isDirectory());
  fs.rmdirSync(cfg);
  const r2 = await mod.agentsFile("setWorkspace", { path: "" });
  ok("清除成功", r2 && r2.ok === true && r2.cleared === true);
  ok("配置已删", !fs.existsSync(cfg));
  const list2 = await mod.agentsFile("list", {});
  ok("清除后无 workspace scope", !(list2.rows || []).some((r) => r.scope === "workspace"));

  const bad = await mod.agentsFile("setWorkspace", { path: "relative/path" });
  ok("相对路径被拒", bad.ok === false && /绝对路径/.test(bad.error), bad.error);
  const noDir = await mod.agentsFile("setWorkspace", { path: "C:/definitely/not/exists/xyz" });
  ok("不存在目录被拒", noDir.ok === false && /不存在/.test(noDir.error), noDir.error);
}

console.log("\n── preset 不再处理该动作 ──");
{
  const r = await mod.preset("setWorkspace", { path: "C:/tmp" });
  ok("preset 不返回写盘结果", !(r && r.ok === true && r.workspace), JSON.stringify(r).slice(0, 100));
}

console.log("\n── 前端守卫 ──");
{
  const cjs = fs.readFileSync(PKG + "/client.js", "utf8");
  const src = fs.readFileSync(PKG + "/client.settings.js", "utf8");
  ok("hqCall 不引用已删的 fetchToken", !/fetchToken/.test(cjs));
  ok("hqCall 走同源 fetch", /function hqCall[\s\S]{0,300}fetch\("\/dxkjailbreak\/console"/.test(cjs));
  ok("loadedScope 已跟踪", /loadedScope/.test(src));
  ok("save 前校验作用域一致", /loadedScope\s*!==\s*sel\.value/.test(src));
}

{
  const profileDir = path.join(home, "profiles", "desktop");
  const manifestFile = path.join(profileDir, "package.json");
  const builtIn = "@deepseek-ai/dsh-base";
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = { dependencies: { "fixture-plugin": "1.0.0" }, dsh: { profile: { bundles: [builtIn, "fixture-plugin"] } } };
  const before = JSON.stringify(manifest);
  fs.writeFileSync(manifestFile, before);
  const list = await mod.profilePlugins("list");
  ok("编成标记宿主必需项", list.ok && list.rows.some(row => row.name === builtIn && row.hostRequired));
  const refused = await mod.profilePlugins("disable", { name: builtIn });
  ok("宿主基础 bundle 无法停用", !refused.ok && fs.readFileSync(manifestFile, "utf8") === before);
  const disabled = await mod.profilePlugins("disable", { name: "fixture-plugin" });
  ok("普通插件依然可以停用", disabled.ok && JSON.parse(fs.readFileSync(manifestFile, "utf8")).dsh.profile.bundles.join() === builtIn);
}

fs.rmSync(target, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
