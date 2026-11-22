// v1.0.1 #16 回归：自部署 + profile 指向部署副本（隔离 DSH_HOME，真实宿主零接触）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; } else { fail++; console.log("FAIL " + l + (x ? "  " + x : "")); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-r8-"));
const profDir = path.join(home, "profiles", "desktop");
fs.mkdirSync(profDir, { recursive: true });
fs.writeFileSync(path.join(profDir, "package.json"), JSON.stringify({
  name: "dsh-profile-desktop", private: true,
  dependencies: { dxkjailbreak: "file:" + path.join(home, "demo-workspace", "dxkjailbreak").replace(/\\/g, "/") },
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
}, null, 2) + "\n");
fs.writeFileSync(path.join(home, "AGENTS.md"), "# baseline\n");
fs.writeFileSync(path.join(home, "prompt-inject.md"), "baseline\n");

const r = spawnSync(process.execPath, ["install.mjs"], {
  cwd: SRC, env: { ...process.env, DSH_HOME: home, DXKJAILBREAK_QUIET: "1" },
  stdio: "pipe", encoding: "utf8", timeout: 120000,
});
// 安装器现在只在 pnpm / apply / selfcheck 全部成功时才 exit 0；隔离环境没有真实宿主，
// apply+selfcheck 必然失败 → exit 3 是**正确**的如实报告（旧版无论成败都打印"安装完成"）。
ok("install 如实报告（0=全成功 / 3=步骤未完成 / 4=依赖失败中止）",
  r.status === 0 || r.status === 3 || r.status === 4,
  "status=" + r.status);
// 任何结局都必须如实报告：0=安装完成 / 3=步骤未完成 / 4=依赖失败，绝不允许"闷声退出"
const output = String(r.stdout || "") + String(r.stderr || "");
ok("结局如实报告（完成/未完成各有明确文案）",
  r.status === 0 ? /安装完成/.test(output)
    : (r.status === 3 || r.status === 4) ? /安装未完成|依赖安装失败/.test(output)
      : false,
  "status=" + r.status);
const deploy = path.join(home, "plugins", "dxkjailbreak");
ok("部署副本存在且版本一致", fs.existsSync(path.join(deploy, "package.json"))
  && JSON.parse(fs.readFileSync(path.join(deploy, "package.json"), "utf8")).version
    === JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version);
ok("部署副本子插件与源目录一致", (() => {
  const d = path.join(deploy, "plugins");
  const s = path.join(SRC, "plugins");
  if (!fs.existsSync(d) || !fs.existsSync(s)) return false;
  const list = (p) => fs.readdirSync(p).filter((n) => fs.existsSync(path.join(p, n, "package.json"))).sort();
  return JSON.stringify(list(d)) === JSON.stringify(list(s));
})());
const after = JSON.parse(fs.readFileSync(path.join(profDir, "package.json"), "utf8"));
const deps = after.dependencies || {};
const deploySpec = deploy.replace(/\\/g, "/");
ok("本体依赖指向部署副本", ["link:" + deploySpec, "file:" + deploySpec].includes(deps["dxkjailbreak"]), deps["dxkjailbreak"]);
ok("无依赖指向源目录", !Object.values(deps).some((v) => {
  const spec = String(v);
  const target = spec.replace(/^(file:|link:)/, "");
  return (spec.startsWith("file:") || spec.startsWith("link:")) && target === SRC.replace(/\\/g, "/");
}));
ok("bundles 含本体+11子插件", (() => {
  const b = after.dsh?.profile?.bundles || [];
  return b.includes("dxkjailbreak") && b.includes("@dxkjailbreak/dsh-refusal-guard") && b.includes("@dxkjailbreak/dsh-sec-enforce");
})());
const patch = fs.readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
ok("本体 insert 块在", /- insert:\s*\n\s+- id: dxkjailbreak\s*\n\s+name: dxkjailbreak\s*\n\s+inject: \[systemPrompt, tools\]/.test(patch));
ok("prompt-inject.md 含甲尾段", fs.readFileSync(path.join(home, "prompt-inject.md"), "utf8").includes("House Rules"));
fs.rmSync(home, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
