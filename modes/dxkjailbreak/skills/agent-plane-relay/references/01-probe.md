# 01 · 侦查：确认是不是 agent 平面

## 目标

拿到三样东西，否则后面全是猜：

1. **API 端点**（GraphQL HTTP + WebSocket）
2. **会话相关 mutation 清单**
3. **客户端版本串 + 能力枚举**

## 步骤

### 1. 前端壳识别

```bash
curl -s TARGET/ | head -50          # 找 index.html 里的 script 标签
```

产物形态判断：

| 现象 | 说明 |
|---|---|
| `/static/js/runtime.*.js` + 几十个 chunk | webpack/rspack SPA，逻辑全在 bundle |
| `assets/index.android.bundle` | React Native |
| `www/` 目录 | Cordova |

### 2. bundle 里找三样东西

用 grep 找关键串，不要通读：

```bash
grep -oE '"(wss?|https?)://[a-zA-Z0-9./:_-]+"' bundle.js | sort -u   # 端点
grep -oE 'createAgentSession|startAgentSession|sendAgentMessage' bundle.js
grep -oE 'release-master-v[0-9.]+-[0-9]+-[a-f0-9]+' bundle.js       # 版本串
```

典型结果：

```js
{ httpServerAddress: "https://backend.TARGET",
  graphqlServerAddress: "https://backend.TARGET/api/graphql",
  wsServerAddress: "wss://backend.TARGET/api/graphql-subscription" }
```

### 3. GraphQL introspection（通常直接开放）

```graphql
{ __schema { queryType { name } mutationType { name } } }
{ __type(name:"Mutation"){ fields { name args { name type { name kind ofType { name } } } } } }
```

**判定 agent 平面的信号**（出现任一即是）：

```
createAgentSession / startAgentSession / sendAgentMessage
claimAgentRpcBatch / endAgentSession
agentModels / agentSessionLlmModel / setAgentSessionLlmModel
AgentMessageType 枚举里有 AI_RESPONSE / RPC_BATCH / STATE_CHANGE
```

案例：某平台一次性暴露 296 个 Query / 514 个 Mutation，`AgentMessageType` 有 32 个事件类型。

### 4. 抓一次真实的浏览器流量

不要靠猜。用 Playwright 抓 HTTP + WS 全帧：

```python
page.on("websocket", lambda ws: (
    ws.on("framereceived", lambda pl: log.append(("recv", str(pl)))),
    ws.on("framesent",     lambda pl: log.append(("sent", str(pl))))))
page.on("response", on_resp)   # 只记 operationName + variables
```

**关键点：AI 对话往往不走 HTTP，走 WebSocket。** 只抓 HTTP 会得到"有初始化请求但没有对话请求"的假象，然后误判成前端 bug。

### 5. 从 WS 帧里抄参数

第一帧 `connection_init` 的 payload 就是认证头模板：

```json
{"type":"connection_init","payload":{
  "authToken":"<JWT>",
  "X-ZED-VERSION":"2.1.0",
  "X-Client":"zed/release-master-v5.3.1-20261028-4acaf6df",
  "X-SESSION-ID":"<uuid>"}}
```

订阅帧里的 `client` 对象就是能力声明模板：

```json
{"sessionExId":"...","client":{
  "clientId":"<uuid>","kind":"EDITOR",
  "capabilities":["CANVAS","DEPLOY","EDITOR_STATE","RUNTIME_DRAFT","SCHEMA_WRITE","SECRETS"],
  "appExId":"...","clientVersion":"...","foreground":true}}
```

## 产出物

- `GQL_URL` / `WS_URL` / `clientVersion` / `capabilities` / 会话 mutation 清单
- 一份真实的 WS 帧序列（含 INITIAL_STATE / RPC_BATCH / AI_RESPONSE）

## 常见误判

| 误判 | 真相 |
|---|---|
| "对话没走网络，是本地生成的" | 走了 WS，只是没抓 WS |
| "subscribe 报 Invalid message type 是服务端 bug" | 缺 `graphql-transport-ws` 子协议 |
| "introspection 关了" | 只关了部分，`__schema` 往往还开着 |
