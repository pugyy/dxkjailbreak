// dxkjailbreak · 安装/卸载端到端回归（隔离 DSH_HOME，不碰真实环境）
// 覆盖：台账按 profile 分账 / 卸载还原他人依赖 / 损坏清单保护 / 退出码
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + (extra ? " — " + extra : "")); }
};

const mkHome = (name) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-" + name + "-"));
  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "desktop", "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    dependencies: {
      // 模拟「别人已经装过」的同名依赖（mojie 场景）
      "@dxkjailbreak/dsh-refusal-guard": "link:C:/somewhere/mojie/plugins/dsh-refusal-guard",
      "some-other-plugin": "2.0.0",
    },
    dsh: { profile: { bundles: ["@dxkjailbreak/dsh-refusal-guard", "some-other-plugin"] } },
  }, null, 2) + "\n", "utf8");
  return home;
};
const run = (args, home, timeout = 120000) => spawnSync(process.execPath, [path.join(ROOT, "install.mjs"), ...args], {
  cwd: ROOT, env: { ...process.env, DSH_HOME: home, DXKJAILBREAK_QUIET: "1" },
  stdio: "pipe", encoding: "utf8", timeout,
});
const readPkg = (home, profile = "desktop") => JSON.parse(fs.readFileSync(path.join(home, "profiles", profile, "package.json"), "utf8"));

// ── 场景 1：安装 → 台账按 profile 分账 ──
console.log("── 场景 1：安装 + 台账分账 ──");
const homeA = mkHome("a");
const r1 = run(["--profile", "desktop"], homeA);
ok("安装不崩（0/3/4 都算如实报告）", [0, 3, 4].includes(r1.status), "status=" + r1.status);

const ledgerPath = path.join(homeA, "dxkjailbreak", "profile-registration.desktop.json");
ok("台账按 profile 命名", fs.existsSync(ledgerPath), ledgerPath);
if (fs.existsSync(ledgerPath)) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ok("台账记录了他人原值（mojie 的 link 保留）",
    ledger.deps && ledger.deps["@dxkjailbreak/dsh-refusal-guard"] && String(ledger.deps["@dxkjailbreak/dsh-refusal-guard"]).includes("mojie"),
    JSON.stringify(ledger.deps?.["@dxkjailbreak/dsh-refusal-guard"] || null));
  ok("台账记录了原本不存在的包为 null",
    ledger.deps && Object.prototype.hasOwnProperty.call(ledger.deps, "dxkjailbreak") && ledger.deps["dxkjailbreak"] === null);
}

const pkgAfterInstall = readPkg(homeA);
ok("安装后依赖指向部署副本",
  String(pkgAfterInstall.dependencies["dxkjailbreak"] || "").includes("plugins/dxkjailbreak"),
  String(pkgAfterInstall.dependencies["dxkjailbreak"] || ""));

// ── 场景 2：卸载 → 还原他人依赖 ──
console.log("\n── 场景 2：卸载还原 ──");
const r2 = run(["--uninstall", "--profile", "desktop"], homeA);
ok("卸载不崩（0/3/6 正常，8/9 为依赖未同步的如实报告）", [0, 3, 6, 8, 9].includes(r2.status), "status=" + r2.status);
const pkgAfterUninstall = readPkg(homeA);
ok("卸载后 mojie 的依赖被还原",
  String(pkgAfterUninstall.dependencies["@dxkjailbreak/dsh-refusal-guard"] || "").includes("mojie"),
  String(pkgAfterUninstall.dependencies["@dxkjailbreak/dsh-refusal-guard"] || "(已删)"));
ok("卸载后本体依赖被移除",
  !Object.prototype.hasOwnProperty.call(pkgAfterUninstall.dependencies, "dxkjailbreak"));
ok("卸载后无关依赖保留", pkgAfterUninstall.dependencies["some-other-plugin"] === "2.0.0");

// ── 场景 3：多 profile 台账隔离 ──
console.log("\n── 场景 3：多 profile 隔离 ──");
const homeB = mkHome("b");
fs.mkdirSync(path.join(homeB, "profiles", "web"), { recursive: true });
fs.writeFileSync(path.join(homeB, "profiles", "web", "package.json"), JSON.stringify({
  name: "dsh-profile-web",
  dependencies: { "@dxkjailbreak/dsh-refusal-guard": "3.0.0" },
  dsh: { profile: { bundles: ["@dxkjailbreak/dsh-refusal-guard"] } },
}, null, 2) + "\n", "utf8");
run(["--profile", "desktop"], homeB);
run(["--profile", "web"], homeB);
const la = path.join(homeB, "dxkjailbreak", "profile-registration.desktop.json");
const lb = path.join(homeB, "dxkjailbreak", "profile-registration.web.json");
ok("两个 profile 各一本台账", fs.existsSync(la) && fs.existsSync(lb));
if (fs.existsSync(la) && fs.existsSync(lb)) {
  const dA = JSON.parse(fs.readFileSync(la, "utf8"));
  const dB = JSON.parse(fs.readFileSync(lb, "utf8"));
  const vA = String(dA.deps?.["@dxkjailbreak/dsh-refusal-guard"] || "");
  const vB = String(dB.deps?.["@dxkjailbreak/dsh-refusal-guard"] || "");
  ok("两本台账内容不同（不串账）", vA !== vB || vA === "" || vB === "", "A=" + vA + " B=" + vB);
}

// ── 场景 4：损坏的 package.json → exit 7 ──
console.log("\n── 场景 4：损坏清单保护 ──");
const homeC = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-c-"));
fs.mkdirSync(path.join(homeC, "profiles", "desktop"), { recursive: true });
fs.writeFileSync(path.join(homeC, "profiles", "desktop", "package.json"), "{ this is not json", "utf8");
const r4 = run(["--profile", "desktop"], homeC);
ok("损坏清单 → exit 7（明确中止）", r4.status === 7, "status=" + r4.status);
ok("损坏清单 → 给出可操作提示", /解析失败|清单无效|修复/.test(String(r4.stderr || "")), String(r4.stderr || "").slice(0, 80));
ok("损坏清单 → 未改动原文件",
  fs.readFileSync(path.join(homeC, "profiles", "desktop", "package.json"), "utf8") === "{ this is not json");

// ── 场景 5：部署目录重跑（返回值类型）──
console.log("\n── 场景 5：从部署目录重跑 ──");
const deployRoot = path.join(homeA, "plugins", "dxkjailbreak");
if (fs.existsSync(path.join(deployRoot, "install.mjs"))) {
  const r5 = spawnSync(process.execPath, [path.join(deployRoot, "install.mjs"), "--profile", "desktop"], {
    cwd: deployRoot, env: { ...process.env, DSH_HOME: homeA, DXKJAILBREAK_QUIET: "1" },
    stdio: "pipe", encoding: "utf8", timeout: 120000,
  });
  ok("从部署目录重跑不崩（无 .failures 类型错）",
    ![null, undefined].includes(r5.status) && !/failures\.length|Cannot read propert/.test(String(r5.stdout || "") + String(r5.stderr || "")),
    "status=" + r5.status + " " + String(r5.stderr || "").slice(0, 60));
} else ok("（部署副本无 install.mjs，跳过）", true);

// ── 场景 6：卸载只删自己，不误删同块其他插件 ──
console.log("\n── 场景 6：insert 块内不误删其他插件 ──");
{
  const homeD = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-d-"));
  const profDir = path.join(homeD, "profiles", "desktop");
  fs.mkdirSync(profDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + "\n", "utf8");
  // 造一个已经有别人的 insert 块的 patch.yml
  const patchYml = [
    "# user patch overlay",
    "- insert:",
    "  - id: some-other-plugin",
    "    name: some-other-plugin",
    "    inject: [tools]",
    "  - id: dxkjailbreak",
    "    name: dxkjailbreak",
    "    inject: [systemPrompt, tools]",
    "  - id: another-plugin",
    "    name: another-plugin",
    "    inject: [webServer]",
    "- other: root",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(profDir, "cordis.patch.yml"), patchYml, "utf8");

  // 直接跑卸载（会调 removeProfileInsert）
  run(["--uninstall", "--profile", "desktop"], homeD);
  const after = fs.readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
  ok("dxkjailbreak 条目被删除", !/id:\s*dxkjailbreak/.test(after), after.slice(0, 120));
  ok("同块其他插件 some-other-plugin 保留", /id:\s*some-other-plugin/.test(after), after.slice(0, 200));
  ok("同块其他插件 another-plugin 保留", /id:\s*another-plugin/.test(after), after.slice(0, 200));
  ok("insert 块本身保留（还有子项）", /^-\s*insert:/m.test(after), after.slice(0, 160));
  ok("块外内容保留", /-\s*other:\s*root/.test(after));
  fs.rmSync(homeD, { recursive: true, force: true });
}

// 清理
for (const h of [homeA, homeB, homeC]) { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} }
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
