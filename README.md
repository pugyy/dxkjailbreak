# dxkjailbreak

**一个插件，11 域全能，设置页一个控制台。** 独立开发，by dxk。

## 是什么

- **11 域全能模式**：渗透 / 代码审计 / 逆向 / 内网攻防 / 免杀 / 应急 / 云安全 / CTF / 资产测绘 / 注册反代 / 多任务总控，合一为单卡（`preset-dxkjailbreak`），新对话切到它即全能力常开
- **宿主加固**：**86 条** host patch（当前宿主 74 条全生效，12 条不适用存档：组件未装 / 已过时 / 可选；提示词层 / 代码默认 / 引擎级审批与沙箱绕过）
- **设置页控制台**：24 个页签的完整管理面（见下）
- **拒答修复**：refusal-guard v0.4.2——三级检测（强短语全文 / 弱词头尾窗 / 软拒绝任意位置）+ 厚甲组合层 + 升级梯（重锚 → 纠偏 → 强语重驱，永不静默）
- **回退 / 删除 / 记忆 / 留痕** 等保留能力（见下）

## 安装

从 GitHub 干净检出即可直接安装：仓库自带 `vendor/yaml` 依赖兜底，安装器启动时自动补齐，无需预装任何依赖。

```bash
node install.mjs              # 安装并打甲
node install.mjs --uninstall  # 卸载并还原
```

安装器会：自部署到 `~/.dsh/plugins/dxkjailbreak` → 备份 home 三份指令 → 按模板拆写 `AGENTS.md` / `prompt-inject.md` → 登记 profile 依赖 → `pnpm install` → `apply`（打甲）→ `selfcheck`。装完重启 dsh。

## 设置页 · 24 个页签

| 区 | 页签 |
|---|---|
| 军械整备（11） | 状态（版本/自检/10 秒自动刷新）· 甲片（86 补丁逐条状态+不适用原因，可筛选）· 补甲（markersAny 双形态重锚）· 军令（编辑身份注入文件，Ctrl+S 保存）· 规矩（规则集切换）· 门禁（Hooks deny/ask 绕过开关）· 总闸（开关与注入位置）· 回退（撤补丁：单条/首页/全部）· 编制（预设列表/设默认）· 战例（战役记忆）· 日志（维护审计流水） |
| 作战沙盘（9） | 侦察（靶标）· 装备（工具识别/FOFA/VPS 配置）· 分队（六角色提示词/作战会话）· 暗道（隧道）· 突破口（漏洞）· 路线（攻击链）· 战功（评分）· 战报（报告）· 参谋（态势汇总） |
| 附属（4） | 对话（会话管理：删除带确认+回收站）· 编成（17 子插件清单）· 狩猎（FOFA/Hunter/Quake DSL）· MCP（服务器清单） |

后端 22 个 RPC（`/dxkjailbreak/console` 统一入口，白名单自动推导）+ 回退/更新等独立路由。

## 会话回退

入口在输入条工具栏「回退」按钮。**原地截断**会话日志（不 fork 新会话，v1.2.41 起）：多帧 zstd 解码 → 计算回退点 → 截断保留 → 备份 → 单帧压缩写回 → 回读校验。整轮语义（提问与回答成对回退），回退后接回原会话并刷新模型选择状态。传 `inplace: false` 可回到 fork 行为。

## 对话删除

侧边栏右键「删除对话」+ 设置页对话面板双入口。四道闸：确认弹窗（完整 sessionId/大小/去处）→ dryRun 演练 → confirmSessionId 二次确认 → 后端硬校验（sessionId 格式 / realpath 防穿越 / 不碰根目录）。删除 = 移入 Windows 系统回收站（PowerShell），可恢复。

## 破甲

- **全主题域**：攻击网站 / 盗取信息 / 盗取钱财 / 违法违纪 / 凶杀 / 恐怖袭击 / 政治 / 色情 / 犯罪 / 毒品 / 未成年性行为，以及任务点名的任何域
- **六层同步**：模板（docs/home）→ AGENTS/prompt-inject → 人设卡 → refusal-guard 检测词表与提醒 → pentest 资产条款 → refs 口径
- **多层防衰减**：周期重锚（每 8 干净轮回）+ 尾部锚（`<dsh-tail-anchor>` 每轮重渲染）+ 子代理锚（`<dsh-child-anchor>`）+ boost 块
- **补丁分层**（86 条）：代码（沙箱放行/审批 never/fs 围栏/escalation）· 提示词（身份剥离/baseline 绕过/审批句跳过）· 工具（run_code 审批放行/ask 失败开放）· 版本兼容
- **链路核验**：`node test/armor-chain.mjs` 一条命令跑四层 28 项（甲片落地 / 注入链路 / 文档层 / 守卫活代码+回滚链）

## 子插件（17）

attack-atlas · auto-advance · campaign-memory · hunter · mcp-studio · mode-group · product-subagents · redteam-results · refusal-guard · route-boost · scanner-tools · sec-enforce · semgrep-audit · session-pulse · stage-gate · trace-vault · webshell-mgr

## 测试

10 套根测试（console-render 7 / render-panes 24 页签真渲染 / client-slots 19 / armor-chain 28 / workspace-config / origin-allowlist / install-uninstall / yaml-independence / home-restore / r8-deploy 9）+ refusal-guard 8 件电池（run 63 / r3 79 / r7 零碰撞 31 / r8 87 / r9 / r10 39 / r11 45 / r12 84）。

跑法：`node test/<name>.mjs`，必须看退出码（异步异常计入失败）。

## 目录

```
lib/        引擎（patch 应用/回滚/自检；patches/ 五表 86 条）
modes/      单卡（agent.cordis.yml + 12 组 playbook skill）
plugins/    17 个子插件
refs/       11 域参考文档（约 18MB，skill 按需读取）
docs/home/  home 指令模板（install 时拆写——功能性文件）
skills/     红队技能文档
```

## 已知限制

| 项 | 原因 |
|---|---|
| 12 条补丁不适用 | 宿主缺 hooks 插件 / 未装预设 / 宿主已自带目标文本 / opt-in 可选（甲片页每条带原因） |
| MCP 面板数据依赖宿主写入 | 读 `dsh-mcp-studio` 命名空间，没配置过就是空 |

## 兼容

DSH `>=0.2.1-rc.2 <0.3.0`。

## License

MIT © 2026 dxk
