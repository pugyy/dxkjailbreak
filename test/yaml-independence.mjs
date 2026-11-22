// dxkjailbreak · 部署副本的 yaml 独立性回归
// 覆盖：部署后 yaml 是实体目录（非 junction）、版本一致、有来源记账、
//       源目录移走后仍能解析 yaml 且部署副本 CLI 能启动
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { fileURLToPath } from "node:url";

// 安全护栏：这个测试原本会重命名「整个包目录」来验证 yaml 能否独立解析。
// 在正在使用的安装目录里跑会短暂让插件不可用。
// 现在默认只做只读校验；要跑破坏性分支需显式 DXK_ALLOW_DESTRUCTIVE_TEST=1 且不在安装目录。
const __installedDir = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh", "plugins", "dxkjailbreak") : "";
const __here = path.dirname(fileURLToPath(import.meta.url));
const __inInstalled = __installedDir && __here.toLowerCase().startsWith(__installedDir.toLowerCase());
if (__inInstalled && !process.env.DXK_ALLOW_DESTRUCTIVE_TEST) {
  console.log("  skipped 在安装目录内运行破坏性测试（设 DXK_ALLOW_DESTRUCTIVE_TEST=1 可强制执行）");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log("ok   " + l); } else { fail++; console.log("FAIL " + l + (e ? " — " + e : "")); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-yamlind-"));
fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
fs.writeFileSync(path.join(home, "profiles", "desktop", "package.json"),
  JSON.stringify({ name: "dsh-profile-desktop", dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + "\n", "utf8");

const env = { ...process.env, DSH_HOME: home, DXKJAILBREAK_QUIET: "1" };
const run = (cwd, args) => spawnSync(process.execPath, [path.join(cwd, "install.mjs"), ...args], {
  cwd, env, stdio: "pipe", encoding: "utf8", timeout: 300000,
});

console.log("── 安装 ──");
const r1 = run(ROOT, ["--profile", "desktop"]);
ok("安装不崩", [0, 3, 4].includes(r1.status), "status=" + r1.status);

const deploy = path.join(home, "plugins", "dxkjailbreak");
const depYaml = path.join(deploy, "node_modules", "yaml");
ok("部署副本存在", fs.existsSync(deploy));
ok("部署副本有 node_modules/yaml", fs.existsSync(depYaml), depYaml);

// 关键：必须是实体目录，不是 symlink/junction
let isLink = false;
try { isLink = fs.lstatSync(depYaml).isSymbolicLink(); } catch { /* 不存在 */ }
ok("yaml 是独立实体（非 junction）", fs.existsSync(depYaml) && !isLink, isLink ? "是链接" : "");

ok("yaml/package.json 存在", fs.existsSync(path.join(depYaml, "package.json")));
ok("yaml/dist/index.js 存在", fs.existsSync(path.join(depYaml, "dist", "index.js")));
ok("有来源记账文件", fs.existsSync(path.join(deploy, "node_modules", ".dxk-yaml-source.json")));

// 版本与源一致
try {
  const vDep = JSON.parse(fs.readFileSync(path.join(depYaml, "package.json"), "utf8")).version;
  const vSrc = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "yaml", "package.json"), "utf8")).version;
  ok("yaml 版本与源一致（" + vDep + "）", vDep === vSrc, vDep + " vs " + vSrc);
} catch (e) { ok("yaml 版本可读", false, String(e.message).slice(0, 80)); }

console.log("\n── 模拟源目录不可用（改名）──");
const hidden = ROOT + ".hidden-for-test";
let renamed = false;
try {
  fs.renameSync(ROOT, hidden);
  renamed = true;
  console.log("  源目录已临时改名 → " + path.basename(hidden));
} catch (e) {
  console.log("  无法改名源目录（" + String(e.message).slice(0, 60) + "），改用解析测试");
}

try {
  // 从部署副本解析 yaml（模拟卸载链的第一行 import）
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import('yaml').then(m=>console.log('YAML_OK '+typeof m.parse)).catch(e=>{console.error(e.code||e.message);process.exit(1)})"],
    { cwd: deploy, env, stdio: "pipe", encoding: "utf8", timeout: 30000 });
  const out = (String(probe.stdout || "") + String(probe.stderr || "")).trim();
  ok("源目录不可用时仍能解析 yaml", probe.status === 0 && /YAML_OK/.test(out), out.slice(0, 120));

  // 部署副本的卸载入口能否启动（--status 只读，验证模块加载）
  const st = spawnSync(process.execPath, [path.join(deploy, "bin", "dxkjailbreak.js"), "--status"], {
    cwd: deploy, env, stdio: "pipe", encoding: "utf8", timeout: 60000,
  });
  const sout = (String(st.stdout || "") + String(st.stderr || "")).trim();
  ok("部署副本 CLI 能启动（源目录不在）", !/ERR_MODULE_NOT_FOUND|Cannot find package/.test(sout), sout.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120) || "");
} finally {
  if (renamed) {
    try { fs.renameSync(hidden, ROOT); console.log("  源目录已恢复"); } catch (e) { console.log("  ✗ 恢复失败：" + e.message); }
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
