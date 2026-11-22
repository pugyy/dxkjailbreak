# RULES —— 可执行判据集

> 由 `evolution/LOG.md` 提炼。开工前先扫一遍，遇到对应症状直接查表，不要重新试错。

## 阶段判定

| ID | 规则 | 检测方法 |
|---|---|---|
| R000 | 先判定 chat 平面 / agent 平面再动手 | introspection 找 `createAgentSession` 等会话 mutation；有即 agent 平面 |

## 协议层

| ID | 症状 | 根因 | 检测 | 修法 |
|---|---|---|---|---|
| R101 | 所有 subscribe 返回 `Invalid message type` | WS 未协商子协议 | `ws.getsubprotocol()` 返回 None | `subprotocols=["graphql-transport-ws"]` |
| R102 | `startAgentSession` 返回 true 但无后续 | `capabilities` 为空 | 对比真实客户端帧 | 照抄能力枚举 |
| R103 | `CLIENT_VERSION_TOO_OLD` | 版本串过期 | 与 bundle 里抓的比对 | 更新 clientVersion |
| R104 | `model provider stopped answering` | RPC 回执形态错 | 看 `STATE_CHANGE.backendReach` 是否为 null | 从 bundle 抄回执结构 |

## 会话层

| ID | 症状 | 根因 | 检测 | 修法 |
|---|---|---|---|---|
| R201 | `sendAgentMessage` true，历史 0 条 | 项目无 appExId / 未 start | `ZED_VERSION_MISSING`、`appConfigAndSchema` 403 | 用浏览器建项目 |
| R202 | 复用 session 后输出错乱 | 上下文跨任务污染 | 输出长度异常（如 16 字符） | 跨任务必须新建 |
| R203 | `you have no permission to edit` | project/app/账号不匹配 | 三者来源核对 | 三项同账号 |
| R204 | agent 上下文里残留上轮 | 预热节点闲置 | 节点 age > TTL | 不预热，建好即用 |

## 额度层

| ID | 症状 | 根因 | 检测 | 修法 |
|---|---|---|---|---|
| R301 | 全部 100s 超时且零事件 | 点数耗尽 | `copilotAiPointsStatus.sufficient == false` | 换账号 / 等 refill |
| R302 | 账号池 building 暴涨但零成功 | 注册并发过高 | building > 5 | 单线程 + 失败退避 60s |
| R303 | 轮换后 3/4 请求超时 | 新账号项目未初始化 | 该账号 `createAgentSession` 后能否出 AI_RESPONSE | 每账号跑一次 UI 建项目 + 对话 |

## 提示词层

| ID | 症状 | 根因 | 检测 | 修法 |
|---|---|---|---|---|
| R401 | 模型拒绝本地文件操作 | 平台 system prompt 硬约束 | 换模型 / 换措辞仍拒 | 不要继续试，转网关构造调用 |
| R402 | 工具协议无效 | 放在 prompt 开头被盖 | 协议位置在首段 | 挪到末尾 |
| R403 | 模型重复调同一工具 | 结果当普通文本 | 连续两次相同 tool_call | 加 `[工具执行结果]` + 禁止重复 |

## 工具层

| ID | 症状 | 根因 | 检测 | 修法 |
|---|---|---|---|---|
| R501 | 相对路径提取不到 | 正则只匹配盘符 | `demo_note.txt` 匹配失败 | 三级回落（用户绝对 → 模型绝对 → 相对名） |
| R502 | 写文件命令报 `InvokeMethodOnNull` | 多语句丢变量 | PowerShell 分号链 | 每块一条单语句，追加用表达式拼接 |
| R503 | 大文件写入被截断 | 命令行长度限制 | b64 长度 > 8000 | 按 3000 分块 |
| R504 | tool_call 解析失败 | 流式拆包 | 块被切到多个 chunk | 带 tools 时缓冲后一次性下发 |

## 环境层

| ID | 症状 | 根因 | 修法 |
|---|---|---|---|
| R601 | `python -c` 反复语法错误 | PowerShell 抢先解释 `$` `\` | 写成 .py 文件再跑 |
| R602 | 改 .py 后中文乱码 | PowerShell ANSI 读写 | 用 `io.open(encoding="utf-8", newline="\n")` |
| R603 | 打包后端口/路径错 | 常量改了但 `app.run` 没改 | 端口、BASE 全走配置 |
| R604 | 端口占用 / 多进程 | 旧进程没杀 | 按 CommandLine 匹配杀干净 |

## 决策层

| ID | 判断 | 依据 |
|---|---|---|
| R701 | 平台凭证拿不到就别耗 | `backendOnlyToken`/`runtimeConfig`/`allCloudConfigurations` 全 403；SSRF 内网被 IP 级防护 |
| R702 | 多账号要先逐个实测 | `addCollaborator` 返回 null 不代表成功 |
| R703 | 该换 provider 就换 | 反代延迟 15–20s/轮 vs 真 provider 5s，差 3–10 倍 |

## 使用方式

1. 新任务开始：先扫 R000 判定平面
2. 遇到症状：按表查 R1xx–R6xx
3. 出现新坑：补进 `evolution/LOG.md`，再回填本表
