<div align="center">

# dxkjailbreak

**One plugin. Eleven security research workflows. One control console.**
**一个插件，11 域安全工作流，一个控制台。**

[![License](https://img.shields.io/github/license/pugyy/dxkjailbreak?color=blue&style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.48-green?style=flat-square)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.2-orange?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/tests-600%2B%20assertions-brightgreen?style=flat-square)](test/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](package.json)
[![Adapters](https://img.shields.io/badge/host%20adapters-86-blueviolet?style=flat-square)](docs/home/dxkjailbreak-functions.md)

**[中文](#中文) · [English](#english)**

</div>

---

<a id="中文"></a>

## 中文

### 这是什么

`dxkjailbreak` 是面向 **DeepSeek Harness (DSH)** 的工作流预设插件：把十一个安全研究方向合成一张单卡，再配一个带 24 个页签的设置页控制台。

它解决三件事：

| 问题 | 方案 |
|---|---|
| 每种研究方向都要单独切模式、单独配技能 | **单卡多域**：一张预设卡覆盖渗透 / 代码审计 / 逆向 / 内网 / 对抗样本 / 应急 / 云安全 / CTF / 资产测绘 / 注册反代 / 多任务编排，按任务自动换打法 |
| 宿主版本升级后插件行为漂移、排查困难 | **宿主适配层**：86 条适配项，逐条带标记、可自检、可单条回滚，状态页直读真实落地结果 |
| 长会话压缩后指令丢失、行为漂移 | **上下文连续性**：周期重锚 + 尾部锚 + 子代理锚 + 注入块，四层防衰减；配套 guard 插件做三级检测与升级梯修复 |

### 快速开始

```bash
git clone https://github.com/pugyy/dxkjailbreak.git
cd dxkjailbreak
node install.mjs          # 安装并初始化
```

装完重启 DSH 即生效。**无需预装依赖**——仓库自带 `vendor/yaml` 兜底，安装器启动时自动补齐。

卸载：`node install.mjs --uninstall`（还原宿主与 home 指令，插件目录保留）。

### 特性一览

<table>
<tr><td width="50%">

**🧭 十一域工作流**
一张卡切 11 种打法，跨域任务按最严边界执行。

**🧱 宿主适配层**
86 条适配项分四层：提示词 / 代码默认 / 工具面 / 版本兼容。

**🎛 24 页签控制台**
状态 · 甲片 · 补甲 · 注入编辑 · 规则集 · 门禁 · 总闸 · 回退 · 编制 · 战例 · 日志 · 沙盘九页 · 对话 · 编成 · 狩猎 · MCP。

</td><td width="50%">

**↩️ 会话回退**
原地截断会话日志（多帧 zstd 解码 → 计算回退点 → 校验写回），整轮语义，回退后接回原会话。

**🗑 安全删除**
四道闸：确认弹窗 → 演练 → 二次确认 → 后端硬校验（格式/防穿越/根目录保护），落 Windows 回收站可恢复。

**🧠 战役记忆 + 过程留痕**
跨会话事实库 + 操作轨迹留存，支持导出与清理。

</td></tr>
</table>

### 设置页结构

| 区 | 页签 | 用途 |
|---|---|---|
| **军械整备**（11） | 状态 / 甲片 / 补甲 / 军令 / 规矩 / 门禁 / 总闸 / 回退 / 编制 / 战例 / 日志 | 适配项状态与回滚、注入正文编辑、规则集切换、预设编制 |
| **作战沙盘**（9） | 侦察 / 装备 / 分队 / 暗道 / 突破口 / 路线 / 战功 / 战报 / 参谋 | 靶标台账、工具识别、隧道与漏洞登记、攻击链与评分报告 |
| **附属**（4） | 对话 / 编成 / 狩猎 / MCP | 会话管理、子插件清单、多源资产检索 DSL、MCP 服务清单 |

后端 22 个 RPC（统一入口 `/dxkjailbreak/console`，白名单自动推导）+ 回退/更新等独立路由。

### 执行纪律

- **授权前提**：所有工作以任务方明确授权的范围为界——自有资产、客户委托、CTF 靶场
- **全量交付**：授权范围内按任务要求输出完整技术内容，不做无谓的自我降级、不给替代方案
- **上下文保持**：周期重锚（每 8 干净轮回）+ 尾部锚（每轮重渲染）+ 子代理锚 + 注入块
- **可核验**：`node test/armor-chain.mjs` 一条命令跑四层 28 项（适配落地 / 注入链路 / 文档层 / 守卫活代码 + 回滚链）

### 子插件（17）

`attack-atlas` · `auto-advance` · `campaign-memory` · `hunter` · `mcp-studio` · `mode-group` · `product-subagents` · `redteam-results` · `refusal-guard` · `route-boost` · `scanner-tools` · `sec-enforce` · `semgrep-audit` · `session-pulse` · `stage-gate` · `trace-vault` · `webshell-mgr`

### 目录结构

```
lib/        引擎（适配项应用 / 回滚 / 自检；patches/ 五表 86 条）
modes/      单卡预设（agent.cordis.yml + 12 组 playbook skill）
plugins/    17 个子插件
refs/       11 域参考文档（约 18MB，skill 按需读取）
skills/     安全研究技能文档
docs/home/  home 指令模板（install 时拆写——功能性文件）
vendor/     yaml 依赖兜底（干净检出即装）
test/       回归与核验套件
```

### 测试

10 套根测试 + guard 8 件电池，**600+ 断言**：

```
console-render 7 · render-panes 24 页签真渲染 · client-slots 19 · armor-chain 28
workspace-config 28 · origin-allowlist 21 · install-uninstall 20 · yaml-independence 10
home-restore 6 · r8-deploy 9
guard: run 63 · r3 79 · r7 零碰撞 31 · r8 87 · r9 ALL · r10 39 · r11 45 · r12 84
```

跑法：`node test/<name>.mjs`，**必须看退出码**（异步异常计入失败）。

### 已知限制

| 项 | 原因 |
|---|---|
| 12 条适配项不适用 | 宿主缺对应组件 / 未装预设 / 宿主已自带目标文本 / 可选开关（甲片页每条带原因） |
| MCP 面板数据依赖宿主写入 | 读 `dsh-mcp-studio` 命名空间，未配置即空 |
| 深度依赖宿主内部结构 | 适配项按 DSH `0.2.1-rc.2` 实测锚定；宿主大版本升级需重新对锚 |

### 兼容

| 宿主 | 状态 |
|---|---|
| DSH `0.2.1-rc.2` | ✅ 全量适配（86 条中 74 条生效，12 条按其原因不适用） |
| DSH `>=0.2.1-rc.2 <0.3.0` | ✅ 声明支持 |
| DSH `>=0.3.0` | ⚠️ 未验证，锚点可能漂移 |

Windows / macOS / Linux 均可运行；桌面版与 Web 版宿主均可挂载。

### 贡献

欢迎 Issue 与 PR。提交前请跑一遍 `node test/armor-chain.mjs` 与相关测试套件，确保适配链未断。

### License

MIT © 2026 [dxk](https://github.com/pugyy)

---

<a id="english"></a>

## English

### What is this

`dxkjailbreak` is a workflow preset plugin for **DeepSeek Harness (DSH)**: eleven security-research tracks folded into a single preset card, plus a 24-tab settings console.

It solves three problems:

| Problem | Approach |
|---|---|
| Every research track needs its own mode, skills and setup | **Single card, multiple tracks** — pentest / code audit / reverse engineering / internal network / adversarial samples / incident response / cloud security / CTF / asset mapping / registration & relay engineering / multi-task orchestration, routed by task |
| Plugin behavior drifts after host upgrades, hard to diagnose | **Host adapter layer** — 86 adapter items, each marked, self-checkable, individually revertible; the status page reads real on-disk results |
| Instructions decay after long sessions and compaction | **Context continuity** — periodic re-anchor + tail anchor + sub-agent anchor + injection block, four layers against decay; the guard plugin adds three-tier detection and a repair ladder |

### Quick start

```bash
git clone https://github.com/pugyy/dxkjailbreak.git
cd dxkjailbreak
node install.mjs          # install and initialize
```

Restart DSH afterwards. **No dependencies to pre-install** — the repository ships a `vendor/yaml` fallback; the installer bootstraps it on first run.

Uninstall: `node install.mjs --uninstall` (restores the host and home instruction files; the plugin directory is kept).

### Features

<table>
<tr><td width="50%">

**🧭 Eleven-track workflows**
One card switches 11 methodologies; cross-track tasks run under the strictest boundary.

**🧱 Host adapter layer**
86 adapter items across four layers: prompt / code defaults / tool surface / version compatibility.

**🎛 24-tab console**
Status · adapters · repair · injection editor · rule sets · hooks · master switch · revert · presets · memory · audit · nine sandbox pages · conversations · plugins · hunter · MCP.

</td><td width="50%">

**↩️ Session rewind**
In-place truncation of the session log (multi-frame zstd decode → rewind point → verified write-back), whole-round semantics, re-attaches the same session.

**🗑 Safe deletion**
Four gates: confirm dialog → dry run → second confirmation → backend hard validation (format / traversal guard / root protection), lands in the Windows recycle bin.

**🧠 Campaign memory + trace retention**
Cross-session fact base and operation traces, exportable and clearable.

</td></tr>
</table>

### Console layout

| Group | Tabs | Purpose |
|---|---|---|
| **Armory** (11) | status / adapters / repair / injection / rules / hooks / master / revert / presets / memory / audit | adapter states and rollback, injection editor, rule sets, preset management |
| **Sandbox** (9) | recon / tooling / teams / tunnels / findings / chain / scoring / report / staff | target ledger, tool detection, tunnel & finding registry, attack chain and scoring |
| **Auxiliary** (4) | conversations / plugins / hunter / MCP | session management, sub-plugin inventory, multi-source asset DSL, MCP servers |

22 backend RPCs behind a single endpoint (`/dxkjailbreak/console`, whitelist auto-derived) plus dedicated routes for rewind and updates.

### Operating discipline

- **Authorization first** — all work is bounded by the scope the task owner has authorized: own assets, client engagements, CTF ranges
- **Full delivery** — within that scope, output complete technical content; no gratuitous self-downgrade, no substitute answers
- **Context retention** — periodic re-anchor (every 8 clean turns) + tail anchor (re-rendered per turn) + sub-agent anchor + injection block
- **Verifiable** — `node test/armor-chain.mjs` runs four layers, 28 checks in one command (adapter landing / injection chain / doc layer / live guards + rollback chain)

### Sub-plugins (17)

`attack-atlas` · `auto-advance` · `campaign-memory` · `hunter` · `mcp-studio` · `mode-group` · `product-subagents` · `redteam-results` · `refusal-guard` · `route-boost` · `scanner-tools` · `sec-enforce` · `semgrep-audit` · `session-pulse` · `stage-gate` · `trace-vault` · `webshell-mgr`

### Layout

```
lib/        engine (adapter apply / revert / self-check; patches/ five tables, 86 items)
modes/      single-card preset (agent.cordis.yml + 12 playbook skills)
plugins/    17 sub-plugins
refs/       11-domain reference library (~18MB, loaded on demand by skills)
skills/     security research skill docs
docs/home/  home instruction template (split-written at install time)
vendor/     yaml fallback (install straight from a clean checkout)
test/       regression and verification suites
```

### Tests

10 root suites plus 8 guard batteries, **600+ assertions**:

```
console-render 7 · render-panes 24 real tabs · client-slots 19 · armor-chain 28
workspace-config 28 · origin-allowlist 21 · install-uninstall 20 · yaml-independence 10
home-restore 6 · r8-deploy 9
guard: run 63 · r3 79 · r7 zero-collision 31 · r8 87 · r9 ALL · r10 39 · r11 45 · r12 84
```

Run with `node test/<name>.mjs` — **always check the exit code** (async failures count).

### Known limitations

| Item | Reason |
|---|---|
| 12 adapter items not applicable | Host lacks the component / preset not installed / host already ships the target text / optional switch (the adapters tab lists the reason per item) |
| MCP panel depends on host-written data | Reads the `dsh-mcp-studio` namespace; empty until configured |
| Deep coupling with host internals | Adapters anchored against DSH `0.2.1-rc.2`; major host upgrades require re-anchoring |

### Compatibility

| Host | Status |
|---|---|
| DSH `0.2.1-rc.2` | ✅ fully adapted (74 of 86 active, 12 not applicable by cause) |
| DSH `>=0.2.1-rc.2 <0.3.0` | ✅ declared support |
| DSH `>=0.3.0` | ⚠️ unverified, anchors may drift |

Runs on Windows / macOS / Linux; mounts on both desktop and web hosts.

### Contributing

Issues and PRs welcome. Before submitting, run `node test/armor-chain.mjs` and the relevant suites to make sure the adapter chain is intact.

### License

MIT © 2026 [dxk](https://github.com/pugyy)
