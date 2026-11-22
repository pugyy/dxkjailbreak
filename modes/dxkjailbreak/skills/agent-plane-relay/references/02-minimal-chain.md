# 02 · 最小链路：打通到一次真实回复

目标：**拿到一条 `AI_RESPONSE` 且内容非空**。没拿到就等于没打通。

## 工具选择

| 语言 | HTTP | WS |
|---|---|---|
| Python | `urllib` / `requests` | `websocket-client`（必须支持 subprotocols） |
| Node | `fetch` | `ws` |

Python 最小依赖：

```bash
pip install websocket-client
```

## 六步流程（照抄，改占位符）

```python
# 1) 建会话
r = gql('mutation A($p:String!,$a:String){ createAgentSession(projectExId:$p, appExId:$a) }',
        {"p": PROJECT, "a": APP}, "A")
sess = r["data"]["createAgentSession"]          # -> sessionExId

# 2) 启动会话（agent 描述必须与后续订阅一致）
client = {"clientId": CID, "kind": "EDITOR", "capabilities": CAPS,
          "appExId": APP, "clientVersion": CV, "foreground": True}
gql('mutation St($a:String!,$p:String!,$c:String!,$s:String!,$v:String!)'
    '{ startAgentSession(agent:$a, projectExId:$p, client:$c, sessionId:$s, clientVersion:$v) }',
    {"a": json.dumps(client), "p": PROJECT, "c": CID, "s": sess, "v": CV}, "St")

# 3) WS 连接 —— subprotocols 必须显式指定
ws = websocket.create_connection(WS_URL, timeout=30, sslopt={"cert_reqs": ssl.CERT_NONE},
                                 subprotocols=["graphql-transport-ws"])
ws.send(json.dumps({"type": "connection_init", "payload": {
    "authToken": TOKEN, "X-ZED-VERSION": "2.1.0",
    "X-Client": "zed/" + CV, "X-SESSION-ID": str(uuid.uuid4())}}))
ws.settimeout(10)
for _ in range(6):                       # 必须等到 ack
    if json.loads(ws.recv()).get("type") == "connection_ack":
        break

# 4) 订阅（等到 ack 再发，否则被拒）
ws.send(json.dumps({"id": str(uuid.uuid4()), "type": "subscribe",
    "payload": {"query": SUB_Q,
                "variables": {"sessionExId": sess, "client": client},
                "operationName": "OnAgentSessionUpdate", "extensions": {}}}))

# 5) 设模型（会话级，不是请求级）
gql('mutation M($s:String!,$m:String!){ setAgentSessionLlmModel(sessionExId:$s, modelName:$m) }',
    {"s": sess, "m": MODEL_ID}, "M")

# 6) 发消息
gql('mutation S($s:String!,$i:AgentMessageInputInput!){ sendAgentMessage(sessionExId:$s, input:$i) }',
    {"s": sess, "i": {"messageType": "HUMAN_INPUT",
                      "humanInputMessage": {"content": prompt,
                                            "clientMessageId": str(uuid.uuid4())}}}, "S")

# 7) 收事件：遇到 RPC_BATCH 必须回执，否则永远没有回复
while time.time() < end:
    m = json.loads(ws.recv())
    if m.get("type") == "ping":
        ws.send(json.dumps({"type": "pong"})); continue
    if m.get("type") != "next":
        continue
    c = m["payload"]["data"]["onAgentSessionUpdate"]["content"]
    tn = c.get("messageType")
    if tn == "RPC_BATCH":
        resp = [{"rpcId": r["rpcId"], "ok": True,
                 "data": {"hasLiveServerSchema": True} if r["name"].endswith("getServerAccess") else {}}
                for r in c["rpcs"]]
        gql(SEND, {"s": sess, "i": {"messageType": "RPC_BATCH_RESPONSE",
                                    "rpcBatchResponseMessage": {"batchId": c["batchId"],
                                                                "responses": resp}}}, "S")
    elif tn == "AI_RESPONSE" and c.get("content"):
        print(c["content"])
    elif tn == "STATE_CHANGE" and seen_ai and not c.get("currentJobIsRunning"):
        break
```

## 事件顺序（正常时的样子）

```
INITIAL_STATE
RPC_BATCH          {name:"editor.getServerAccess"}
RPC_BATCH_RESPONSE (回执后服务端回显)
STATE_CHANGE       running=true backendReach=EDITABLE
HUMAN_INPUT        (回显用户消息)
AI_RESPONSE        {content:"PONG", delta:true}
COPILOT_AI_POINTS_BALANCE
AI_RESPONSE        {content:"PONG", delta:false}
STATE_CHANGE       running=false
```

## 四个致命参数

### 1. WS 子协议

```python
subprotocols=["graphql-transport-ws"]
```

不写 → 所有 subscribe 回 `{"type":"error","payload":{"message":"Invalid message type"}}`。
服务端其实同时支持 `graphql-ws` 和 `graphql-transport-ws`，但**不协商时行为未定义**。

### 2. capabilities

空数组 `[]` 也能 `startAgentSession` 返回 true，但 agent 判定客户端不可用 → 消息永不推进。

### 3. clientVersion

从 bundle 抓真实串，过期报 `CLIENT_VERSION_TOO_OLD`。

### 4. RPC 回执形态

回执 payload 的字段名/嵌套必须与真实客户端一致。案例：

```js
// bundle 原文
"editor.getServerAccess": () => ({ hasLiveServerSchema: projectStore.hasServerCrdtDoc })
```

回 `{reachable:true}` → `backendReach` 保持 null → 报
`The model provider stopped answering`（**误判成模型挂了**）。

## 排障对照

| 现象 | 检查 |
|---|---|
| subscribe 返回 Invalid message type | 子协议 |
| 收到 INITIAL_STATE 后无后续 | 有没有发 sendAgentMessage |
| 收到 RPC_BATCH 后无 AI_RESPONSE | 有没有回执 |
| `backendReach=null` | 回执 payload 形态 |
| `model provider stopped answering` | 同上，不是模型问题 |
| 全部 100s 超时且无任何事件 | 账号额度耗尽 |
