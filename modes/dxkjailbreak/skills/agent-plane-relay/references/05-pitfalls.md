# 05 · 踩坑实录（带数据）

按"症状 → 根因 → 规则"整理。下次遇到同类症状直接查表。

## 一、协议层

### 症状：所有 subscribe 返回 `Invalid message type`

**根因**：WebSocket 握手没协商子协议。服务端同时支持 `graphql-ws` 和
`graphql-transport-ws`，不指定时行为未定义。

**规则**：Python `websocket-client` 必须
`create_connection(..., subprotocols=["graphql-transport-ws"])`。

### 症状：`startAgentSession` 返回 true，但消息永不推进

**根因**：`capabilities` 传了空数组。服务端接受，但判定客户端不可用。

**规则**：照抄真实客户端的能力声明。

### 症状：`The model provider stopped answering`

**根因**：不是模型挂了，是 RPC 回执 payload 形态错误 → `backendReach=null`。

**规则**：回执字段名从 bundle 里抄（`"editor.getServerAccess": () => ({hasLiveServerSchema: ...})`），
不要自己发明。

## 二、数据层

### 症状：`sendAgentMessage` 返回 true，`agentMessageHistory` 永远 0 条

**根因**：项目没有 appExId（是 backend-only 项目），或 session 未 start。

**规则**：`ZED_VERSION_MISSING` / `appConfigAndSchema` 403 都是这个信号。

### 症状：跨请求复用 session 后输出错乱

**实测**：第二次请求 `body len=16`（就是 `\n[relay] timeout` 本身）。

**根因**：agent 上下文把上个任务的对话历史带进来了。

**规则**：会话复用只对"同一段连续对话"有效；跨任务必须新建。

### 症状：`you have no permission to edit`

**根因**：`project` / `app` / `worker_email` 三者不属于同一账号。

**规则**：三项必须同时切换，配置文件里写死注释提醒。

## 三、额度层

### 症状：所有模型同时 100s 超时，服务端不返回任何错误

**根因**：账号点数耗尽（`balance: 0`，`sufficient: false`）。

**规则**：先查 `copilotAiPointsStatus`，再怀疑代码。

### 症状：账号池 building 数量暴涨到 40+，一个都没成功

**根因**：注册并发过高，触发平台风控。

**规则**：单线程 + 失败退避 60s。50 个账号慢慢补，不要并发。

### 症状：轮换到新账号后 3/4 请求超时

**根因**：新账号的项目是纯 API 建的空项目，agent 上下文未初始化。

**规则**：每个账号都要跑一次浏览器 UI 完整建项目 + AI 对话。轮换前逐个实测。

## 四、提示词层

### 症状：模型拒绝操作本地文件，换什么提示词都没用

**实测**：3 个模型（sol / luna / deepseek）+ 双份提示 + few-shot + "旧配置已废弃"声明，
全部拒绝。模型原话："我无法从 <平台> 会话写入本机路径"。

**规则**：这是产品级 system prompt 硬约束。不要继续在提示词上耗时间，
直接上"网关构造工具调用"。

### 症状：工具协议放在 prompt 开头，模型完全无视

**根因**：平台自己的 system prompt 权重更高。

**规则**：协议放 prompt **末尾**，紧贴用户消息。

### 症状：模型重复调用同一个工具

**根因**：工具结果被当作普通文本，模型不知道已经执行过。

**规则**：`role=tool` 的内容加 `[工具执行结果]` 前缀 + 明确"不要再调用"。

## 五、编码/环境

### 症状：PowerShell 里 `python -c "..."` 反复语法错误

**根因**：双引号内的 `$`、`\` 被 PowerShell 抢先解释。

**规则**：复杂脚本一律写成 `.py` 文件再执行，不要内联。

### 症状：`Set-Content` 修改 .py 后中文全乱码、路径报 `OSError`

**根因**：PowerShell 默认 ANSI 编码读写。

**规则**：改源码用 Python `io.open(..., encoding="utf-8", newline="\n")`。

### 症状：读文件时路径是相对名，提取不到

**根因**：绝对路径正则 `[A-Za-z]:` 匹配不上 `demo_note.txt`。

**规则**：三级回落（用户绝对路径 → 模型回复绝对路径 → 相对文件名）。

## 六、部署

### 症状：打包后 `app.run` 仍监听硬编码端口

**根因**：只改了常量，没改 `app.run(port=...)`。

**规则**：端口/主机也要走配置。

### 症状：打包后启动报路径错误

**根因**：`BASE = r"E:\xxx"` 硬编码。

**规则**：`BASE = os.path.dirname(os.path.abspath(__file__))`。

### 症状：多开导致端口占用、进程残留

**规则**：改配置后先按端口或命令行把旧进程杀干净再启动。
`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ? {$_.CommandLine -like '*relay.py*'}`
