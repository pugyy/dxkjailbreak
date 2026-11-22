---
name: agent-plane-relay
description: 当目标平台的 AI 不是 OpenAI 式 chat API，而是"会话 + 工具回执 + 事件订阅"的 agent 平面时，用它把该平台做成兼容 OpenAI/Anthropic 的反代。适用于探查 GraphQL/WS 型 AI 接口、复现 agent 调用链、桥接工具调用、处理额度耗尽与多账号池。触发词：agent 反代、会话型 AI、RPC_BATCH、GraphQL WebSocket AI、平台助手限制、额度耗尽、工具调用不通。
---

# Agent 平面反代方法论

> 平台无关。文中的 `TARGET`、`GQL_URL`、`WS_URL`、`PROJECT`、`APP`、`SESSION`、
> `MODEL_ID`、`TOKEN` 都是占位符，替换成当前目标真实值。
> 案例来自一个可视化编辑器类平台，但结构在同类平台上可迁移。

## ACTION REQUIRED（读完立刻执行）

1. `NOW`：先判定目标是 **chat 平面** 还是 **agent 平面**。判错会白写几千行。
2. `NEXT`：读 `references/01-probe.md` 做侦查，拿到 API 清单与 WS 地址。
3. `NEXT`：读 `references/02-minimal-chain.md` 打通最小链路，产出一次真实回复。
4. `NEXT`：需要工具调用时读 `references/03-tools.md`。
5. `NEXT`：额度耗尽/多账号时读 `references/04-quota-accounts.md`。
6. `ACT`：每步都要有实际响应作证，不要停在"分析可行"。

## 第一判定：chat 平面 vs agent 平面

| 特征 | chat 平面 | **agent 平面** |
|---|---|---|
| 端点 | `/v1/chat/completions` 类 | GraphQL mutation + WebSocket subscription |
| 输入 | messages 数组 | 用户消息 + 工具集 + 客户端能力声明 |
| 输出 | token 流 | 结构化事件（AI_RESPONSE / RPC_BATCH / STATE_CHANGE / TOOL_RESULT） |
| 状态 | 无状态，每次带完整历史 | **有状态**，模型绑在 session 上 |
| 工具 | 客户端声明 `tools`，模型回 `tool_calls` | 平台自带工具，通过 `RPC` 下发给客户端执行 |

**判定方法**：对可疑端点做 introspection，看有没有 `createAgentSession` / `startAgentSession`
/ `sendAgentMessage` / `claimAgentRpcBatch` 这类 mutation。有就是 agent 平面。

agent 平面的反代不是"翻译协议"，而是**扮演一个 agent 客户端**。

## 最小链路（六步，缺一不可）

```
1. createAgentSession(project, app)      -> sessionId
2. startAgentSession(agentJSON, project, clientId, sessionId, clientVersion) -> true
3. WS connect + connection_init + connection_ack
4. WS subscribe(OnAgentSessionUpdate, {sessionExId, client})
5. setAgentSessionLlmModel(sessionId, MODEL_ID)
6. sendAgentMessage(sessionId, HUMAN_INPUT)
   <- INITIAL_STATE
   <- RPC_BATCH {name:"editor.getServerAccess"}
   -> sendAgentMessage(RPC_BATCH_RESPONSE, {...})     ← 不回就永远没有回复
   <- STATE_CHANGE running=true
   <- AI_RESPONSE {content, delta}
```

## 四个致命参数（少一个就静默失败）

1. **WS 子协议**：必须显式 `subprotocols=["graphql-transport-ws"]`。
   不设则所有 subscribe 返回 `Invalid message type`，看起来像服务端 bug。
2. **capabilities 必须写全**：空数组也能 start 成功，但服务端判定客户端不可用，消息永不推进。
   典型值：`["CANVAS","DEPLOY","EDITOR_STATE","RUNTIME_DRAFT","SCHEMA_WRITE","SECRETS"]`。
3. **clientVersion 强校验**：从 bundle 里抓真实版本串，过期报 `CLIENT_VERSION_TOO_OLD`。
4. **RPC 回执形态固定**：回执 payload 结构必须与客户端实现一致
   （案例：`{hasLiveServerSchema: true}`）。回错形态 → `backendReach=null` →
   报 "model provider stopped answering"，误判成模型挂了。

## 工具调用：模型不配合时的三层方案

| 层 | 做法 | 适用 |
|---|---|---|
| L1 | 把客户端 tools 清单写进 prompt，让模型输出 `<tool_call>{...}</tool_call>` | 模型愿意配合时最干净 |
| L2 | 模型拒绝时，网关自己构造工具调用（读/写/执行） | agent 被平台 system prompt 锁死时唯一可行 |
| L3 | 客户端回传工具结果后，标注 `[工具执行结果]` + "不要再调用" | 防止模型重复调用同一工具 |

**关键顺序**：工具协议要放在 prompt **末尾**（紧贴用户消息），放开头会被平台 system prompt 盖掉。

## 额度与账号池

- 平台一般按"点数"计费，点数归零后**不是报错，而是全部请求静默超时**。
  排查任何"突然全部超时"先查余额，不要先怀疑代码。
- 单账号可并发开多个 session，但会话是资源，要有上限。
- 多账号共用项目通常需要协作者权限；`addCollaborator` 返回 null 不代表成功，
  必须用该账号实测 `createAgentSession` 才算数。

## 反模式（会直接浪费时间）

- 拿 chat 平面的经验硬套：直接 POST 一个 `messages` 数组过去，返回一堆奇怪错误
- 只发 mutation 不订阅 WS：`sendAgentMessage` 返回 true，但永远收不到回复
- 忽略 RPC 回执：模型一句话都不说，日志里只有 INITIAL_STATE
- 用"预热 session 池"提速：闲置 session 会被服务端回收，reactivate 反而更慢
- 跨请求复用 session：上一个任务的对话历史会污染下一个（实测出现过输出只剩 16 字符）
- 用点数余额判断"模型是否可用"却不看 `sufficient` 字段

- **流式 / 计费 / 缓存 / 运维日志**：见 `llm-relay-fabrication` 的 `08-sse.md`、`09-billing.md`、`10-cache.md`、`07-ops-log.md`。

## 进化机制

开工前先读 `evolution/RULES.md`（R000–R703 的判据表），遇到症状直接查表，
不要重新试错。

每次踩到新坑，两步归位：

1. 写进 `evolution/LOG.md`：**症状 → 根因 → 规则 → 检测**
2. 回填 `evolution/RULES.md` 对应分类，给一个稳定 ID

ID 分段约定：R0xx 阶段判定 / R1xx 协议 / R2xx 会话 / R3xx 额度 /
R4xx 提示词 / R5xx 工具 / R6xx 环境 / R7xx 决策。

一个规则只有满足"下次能据此直接判断该不该停手"，才值得留在表里。
