# dxkjailbreak

**一个插件，11 域安全研究全能，设置页一个控制台。** 独立开发，by dxk。

## 是什么

- **11 域工作流**：渗透测试 / 代码审计 / 逆向工程 / 内网攻防 / 对抗样本研究 / 应急响应 / 云安全 / CTF / 资产测绘 / 注册与反代工程 / 多任务编排，合一为单卡（`preset-dxkjailbreak`），新对话切到它即全能力常开，不必逐个选模式
- **宿主适配层**：86 条适配项（提示词层 / 代码默认 / 工具面 / 版本兼容），面向 DeepSeek Harness `0.2.1-rc.2` 的执行策略与权限链路对齐，全部带标记、可自检、可回滚
- **设置页控制台**：24 个页签的完整管理面（见下）
- **响应连续性保障**：guard 插件——三级检测 + 升级梯（复述提醒 → 纠偏注记 → 强语重驱），保证长会话与压缩恢复后的指令连续性，永不静默
- **回退 / 删除 / 记忆 / 留痕** 等配套能力（见下）

## 安装

从 GitHub 干净检出即可直接安装：仓库自带 `vendor/yaml` 依赖兜底，安装器启动时自动补齐，**无需预装任何依赖**。

```bash
node install.mjs              # 安装并初始化
node install.mjs --uninstall  # 卸载并还原
```

安装器会：自部署到 `~/.dsh/plugins/dxkjailbreak` → 备份 home 三份指令 → 按模板拆写 `AGENTS.md` / `prompt-inject.md` → 登记 profile 依赖 → `pnpm install` → `apply` → `selfcheck`。装完重启 dsh。

## 设置页 · 24 个页签

| 区 | 页签 |
|---|---|
| 军械整备（11） | 状态（版本/自检/10 秒自动刷新）· 甲片（86 适配项逐条状态+原因，可筛选）· 补甲（双形态重锚）· 军令（编辑注入文件，Ctrl+S 保存）· 规矩（规则集切换）· 门禁（Hooks 策略开关）· 总闸（总开关与注入位置）· 回退（撤销适配项：单条/首页/全部）· 编制（预设列表/设默认）· 战例（战役记忆）· 日志（维护审计流水） |
| 作战沙盘（9） | 侦察（靶标管理）· 装备（工具识别/FOFA/VPS 配置）· 分队（角色提示词/会话）· 暗道（隧道登记）· 突破口（漏洞台账）· 路线（攻击链）· 战功（评分）· 战报（报告）· 参谋（态势汇总） |
| 附属（4） | 对话（会话管理：删除带确认+回收站）· 编成（17 子插件清单）· 狩猎（多源资产检索 DSL）· MCP（服务器清单） |

后端 22 个 RPC（`/dxkjailbreak/console` 统一入口，白名单自动推导）+ 回退/更新等独立路由。

## 会话回退

入口在输入条工具栏「回退」按钮。**原地截断**会话日志（不 fork 新会话，v1.2.41 起）：多帧 zstd 解码 → 计算回退点 → 截断保留 → 备份 → 单帧压缩写回 → 回读校验。整轮语义（提问与回答成对回退），回退后接回原会话并刷新模型选择状态。传 `inplace: false` 可回到 fork 行为。

## 对话删除

侧边栏右键「删除对话」+ 设置页对话面板双入口。四道闸：确认弹窗（完整 sessionId/大小/去处）→ dryRun 演练 → confirmSessionId 二次确认 → 后端硬校验（sessionId 格式 / realpath 防穿越 / 不碰根目录）。删除 = 移入 Windows 系统回收站，可恢复。

## 执行纪律与授权语境

- **授权前提**：所有工作以任务方明确授权的范围为界——自有资产、客户委托、CTF 靶场
- **全量交付**：授权范围内按任务要求输出完整技术内容，不做无谓的自我降级、不给替代方案
- **上下文保持**：周期重锚（每 8 干净轮回）+ 尾部锚（`<dsh-tail-anchor>` 每轮重渲染）+ 子代理锚（`<dsh-child-anchor>`）+ 注入块，保证长会话与压缩恢复后指令不丢
- **分层适配**（86 条）：提示词层 · 代码默认 · 工具面 · 版本兼容，每条带标记与回滚链
- **链路核验**：`node test/armor-chain.mjs` 一条命令跑四层 28 项（宿主适配落地 / 注入链路 / 文档层 / 守卫活代码+回滚链）

## 子插件（17）

attack-atlas · auto-advance · campaign-memory · hunter · mcp-studio · mode-group · product-subagents · redteam-results · refusal-guard · route-boost · scanner-tools · sec-enforce · semgrep-audit · session-pulse · stage-gate · trace-vault · `webshell-mgr`

## 测试

10 套根测试（console-render 7 / render-panes 24 页签真渲染 / client-slots 19 / armor-chain 28 / workspace-config / origin-allowlist / install-uninstall / yaml-independence / home-restore / r8-deploy 9）+ guard 8 件电池（run 63 / r3 79 / r7 零碰撞 31 / r8 87 / r9 / r10 39 / r11 45 / r12 84）。

跑法：`node test/<name>.mjs`，必须看退出码（异步异常计入失败）。

## 目录

```
lib/        引擎（适配项应用/回滚/自检；patches/ 五表 86 条）
modes/      单卡（agent.cordis.yml + 12 组 playbook skill）
plugins/    17 个子插件
refs/       11 域参考文档（约 18MB，skill 按需读取）
docs/home/  home 指令模板（install 时拆写——功能性文件）
skills/     安全研究技能文档
vendor/     yaml 依赖兜底（干净检出自愈）
```

## 已知限制

| 项 | 原因 |
|---|---|
| 12 条适配项不适用 | 宿主缺对应组件 / 未装预设 / 宿主已自带目标文本 / 可选开关（甲片页每条带原因） |
| MCP 面板数据依赖宿主写入 | 读 `dsh-mcp-studio` 命名空间，没配置过就是空 |

## 兼容

DSH `>=0.2.1-rc.2 <0.3.0`。

## License

MIT © 2026 dxk
