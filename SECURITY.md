# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | ✅ |
| < 1.2 | ❌ (please upgrade) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private channel:

1. Go to the **Security** tab of this repository
2. Click **Report a vulnerability** (Private vulnerability reporting)
3. Describe: affected version, file/route involved, reproduction steps, observed impact

If private reporting is unavailable, open a minimal issue asking for a private contact channel — do **not** include exploit details in the issue itself.

### What to include

- `dxkjailbreak` version (`package.json`) and DSH host version
- Operating system and shell
- The exact command or UI path that triggers the issue
- Whether the issue requires local access, an authenticated host, or a crafted file

### Response

| Stage | Target |
|---|---|
| Acknowledgement | within 7 days |
| Triage and severity | within 14 days |
| Fix or mitigation guidance | depends on severity, typically within 30 days |

## Scope

**In scope**

- The installer (`install.mjs`, `setup.cmd`, `install.cmd`, `install.sh`, `uninstall.cmd`) — path handling, privilege boundaries, filesystem writes outside the intended targets
- The console backend (`lib/console-api.js`, `lib/index.js`) — origin/CSRF checks, session-directory validation, RCE or traversal reachable from the console routes
- The console frontend (`client.js`, `client.settings.js`) — XSS, unsafe HTML injection, data exfiltration
- Destructive paths: session deletion, rewind, patch apply/revert — anything that can corrupt a host installation or a user's session data
- Sub-plugins under `plugins/*` — same criteria as above

**Out of scope**

- `refs/` — third-party reference documentation collected from public sources; report to the original authors
- `deploy/assets/kali-mcp-server/` — third-party component, report upstream (see `NOTICE`)
- Findings that require an already-compromised host, physical access, or a malicious local administrator
- Missing hardening headers with no demonstrated impact
- Behaviour that is intentional and documented (for example: applying host patches, writing the home instruction files) — those are the product's purpose, not a vulnerability

## Handling

- Reports are triaged against the current `main` branch
- Fixes land in `main` and are described in the release notes
- Credit is given in the release notes unless you ask to stay anonymous
- No bug bounty is offered; this is a single-maintainer open-source project

## 中文说明

**支持版本**：1.2.x。

**报告方式**：请勿公开提交 issue。走本仓库 **Security** 标签页 → **Report a vulnerability**（私密报告入口）。若私密入口不可用，可开一个不含细节的 issue 索取私密联系方式。

**请附上**：版本号（`package.json`）、DSH 宿主版本、操作系统与 shell、触发命令或 UI 路径、是否需要本地权限或构造文件。

**响应时限**：7 天内确认，14 天内定级，修复或缓解建议通常 30 天内给出（视严重程度）。

**范围内**：安装器（路径处理 / 权限边界 / 越界写入）、控制台后端（同源与 CSRF 校验、会话目录校验、路由可达的任意文件读写或命令执行）、控制台前端（XSS、不安全 HTML 注入、数据外泄）、破坏性路径（会话删除、回退、适配项应用与回滚）、`plugins/*` 子插件。

**范围外**：`refs/`（第三方公开资料，请报告原作者）、`deploy/assets/kali-mcp-server/`（第三方组件，见 `NOTICE`）、需要已失陷主机或物理访问的问题、无实际影响的加固建议、以及产品文档中已说明的设计行为（例如写入 home 指令文件、应用宿主适配项——那是它的用途，不是漏洞）。

**处理**：基于 `main` 分支定级，修复随版本说明公布；除要求匿名外会在发布说明中致谢。本项目为单人维护的开源项目，无赏金计划。
