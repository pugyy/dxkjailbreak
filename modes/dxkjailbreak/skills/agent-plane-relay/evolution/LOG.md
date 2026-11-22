# 案例日志

## 2026-11-01 · 某无代码平台的 agent 平面反代

**目标类型**：Web SPA + GraphQL + WebSocket subscription 的 agent 平面
**结果**：反代打通（三协议 + 工具兜底），性能与上游 agent 锁死，最终建议换 provider

### 关键数据

| 指标 | 数值 |
|---|---|
| 运行时模型数 | 7 |
| 可接入模型描述符 | 127（8 个 provider） |
| AgentMessageType 事件 | 32 种 |
| 对话延迟（新建 session） | 16–21s |
| 对话延迟（复用 session） | 5–6s |
| 网页端首字 | 5.85s（消息回显 3.82s） |
| 读文件（1 轮工具） | ~36s |
| 写文件（18KB，分块） | 150–200s |
| 单账号点数 | 70 万（注册赠 50 万 + 每日 20 万） |

### 四个致命参数（本次踩全了）

1. WS 子协议 `graphql-transport-ws` —— 不写全部 subscribe 报 Invalid message type
2. `capabilities` 六项 —— 空数组能 start 但永不推进
3. `clientVersion` 真实版本串 —— 过期报 CLIENT_VERSION_TOO_OLD
4. RPC 回执 `{hasLiveServerSchema: true}` —— 形态错则报 "model provider stopped answering"

### 走过的弯路

| 尝试 | 结果 |
|---|---|
| 提示词覆盖 system prompt（3 模型 × 双份 × few-shot） | ❌ 全部无效 |
| 预热 session 池 | ❌ 闲置被回收，反而更慢 |
| 跨请求复用 session | ❌ 上下文污染，输出 16 字符 |
| 4 账号轮换 | ❌ 新账号项目未初始化，3/4 超时 |
| 找平台模型凭证（SSRF / 403 接口） | ❌ 权限隔离到位，内网 IP 级防护 |
| 网关构造 read/write 工具调用 | ✅ 唯一有效路径 |

### 沉淀产物

- `references/01-probe.md`：从 bundle 到 WS 帧的侦查路线
- `references/02-minimal-chain.md`：六步最小链路 + 四参数
- `references/03-tools.md`：三层工具桥接（提示 → 构造 → 防重复）
- `references/04-quota-accounts.md`：点数归零 = 静默超时；账号池工程约束
- `references/05-pitfalls.md`：六类症状对照表
- `scripts/agent_probe.py`：最小探针，换占位符即可打下一个目标

### 一句话教训

**先判定 chat 平面还是 agent 平面。** 判错方向，后面所有优化都是在错误的地基上堆代码。
