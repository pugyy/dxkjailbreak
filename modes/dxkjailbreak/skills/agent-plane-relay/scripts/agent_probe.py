#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent 平面最小探针 —— 打通到一次真实 AI_RESPONSE。

用法:
  python agent_probe.py --gql https://backend.TARGET/api/graphql \
      --ws wss://backend.TARGET/api/graphql-subscription \
      --token <JWT> --project <PROJECT> --app <APP> \
      --version release-master-v1.0.0-20260101-deadbeef \
      --caps CANVAS,DEPLOY,EDITOR_STATE --model <MODEL_ID> --prompt "hi"

判定成功: 打印出 AI_RESPONSE 且内容非空。
"""
import argparse, json, ssl, sys, time, uuid

try:
    import websocket
except ImportError:
    print("需要 websocket-client:  pip install websocket-client")
    raise SystemExit(1)


SUB_Q = """
subscription OnAgentSessionUpdate($sessionExId: String!, $client: AgentClientInputInput) {
  onAgentSessionUpdate(sessionExId: $sessionExId, client: $client) {
    type
    content {
      __typename messageType
      ... on AgentAiResponseMessage { content delta }
      ... on AgentErrorMessage { content }
      ... on AgentStateChangeMessage { currentJobIsRunning backendReach }
      ... on AgentRpcBatchMessage { batchId rpcs { rpcId name args } }
      ... on AgentInitialStateMessage { terminated mode }
    }
  }
}
"""


def gql(url, token, query, variables=None, op=None):
    import urllib.request, urllib.error
    body = {"query": query}
    if variables:
        body["variables"] = variables
    if op:
        body["operationName"] = op
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "Authorization": "Bearer " + token,
        "User-Agent": "agent-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return {"httpError": e.code, "body": e.read()[:300].decode("utf-8", "replace")}
    except Exception as e:
        return {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gql", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--version", default="release-master-v1.0.0")
    ap.add_argument("--caps", default="CANVAS,DEPLOY,EDITOR_STATE,RUNTIME_DRAFT,SCHEMA_WRITE,SECRETS")
    ap.add_argument("--model", default="")
    ap.add_argument("--prompt", default="reply with PONG")
    ap.add_argument("--timeout", type=float, default=180)
    a = ap.parse_args()

    caps = [c.strip() for c in a.caps.split(",") if c.strip()]

    print("[1] createAgentSession")
    r = gql(a.gql, a.token,
            'mutation A($p:String!,$a:String){ createAgentSession(projectExId:$p, appExId:$a) }',
            {"p": a.project, "a": a.app}, "A")
    sess = ((r.get("data") or {}).get("createAgentSession"))
    print("   ", sess or json.dumps(r, ensure_ascii=False)[:250])
    if not sess:
        return

    cid = str(uuid.uuid4())
    client = {"clientId": cid, "kind": "EDITOR", "capabilities": caps,
              "appExId": a.app, "clientVersion": a.version, "foreground": True}

    print("[2] startAgentSession")
    r = gql(a.gql, a.token,
            'mutation St($a:String!,$p:String!,$c:String!,$s:String!,$v:String!)'
            '{ startAgentSession(agent:$a, projectExId:$p, client:$c, sessionId:$s, clientVersion:$v) }',
            {"a": json.dumps(client, separators=(",", ":")), "p": a.project,
             "c": cid, "s": sess, "v": a.version}, "St")
    print("   ", json.dumps((r.get("data") or {}), ensure_ascii=False)[:120])

    print("[3] WS + subscribe")
    ws = websocket.create_connection(a.ws, timeout=30, sslopt={"cert_reqs": ssl.CERT_NONE},
                                     subprotocols=["graphql-transport-ws"])
    ws.send(json.dumps({"type": "connection_init", "payload": {
        "authToken": a.token, "X-ZED-VERSION": "2.1.0",
        "X-Client": "zed/" + a.version, "X-SESSION-ID": str(uuid.uuid4())}}))
    ws.settimeout(10)
    for _ in range(6):
        if json.loads(ws.recv()).get("type") == "connection_ack":
            print("    ack")
            break
    ws.send(json.dumps({"id": str(uuid.uuid4()), "type": "subscribe",
                        "payload": {"query": SUB_Q,
                                    "variables": {"sessionExId": sess, "client": client},
                                    "operationName": "OnAgentSessionUpdate", "extensions": {}}}))

    if a.model:
        print("[4] set model:", a.model)
        gql(a.gql, a.token,
            'mutation M($s:String!,$m:String!){ setAgentSessionLlmModel(sessionExId:$s, modelName:$m) }',
            {"s": sess, "m": a.model}, "M")

    print("[5] sendAgentMessage")
    gql(a.gql, a.token,
        'mutation S($s:String!,$i:AgentMessageInputInput!){ sendAgentMessage(sessionExId:$s, input:$i) }',
        {"s": sess, "i": {"messageType": "HUMAN_INPUT",
                          "humanInputMessage": {"content": a.prompt,
                                                "clientMessageId": str(uuid.uuid4())}}}, "S")

    print("[6] events")
    ws.settimeout(2)
    end = time.time() + a.timeout
    got_ai = False
    while time.time() < end:
        try:
            raw = ws.recv()
        except Exception:
            continue
        if not raw:
            continue
        m = json.loads(raw)
        if m.get("type") == "ping":
            ws.send(json.dumps({"type": "pong"}))
            continue
        if m.get("type") != "next":
            continue
        node = (m.get("payload") or {}).get("data", {}).get("onAgentSessionUpdate") or {}
        c = node.get("content") or {}
        tn = c.get("messageType")
        if tn == "RPC_BATCH":
            resp = []
            for rc in c.get("rpcs") or []:
                data = {"hasLiveServerSchema": True} if rc["name"].endswith("getServerAccess") else {}
                resp.append({"rpcId": rc["rpcId"], "ok": True, "data": data})
            print("    RPC_BATCH ->", [r_["name"] for r_ in c.get("rpcs") or []])
            gql(a.gql, a.token,
                'mutation S($s:String!,$i:AgentMessageInputInput!){ sendAgentMessage(sessionExId:$s, input:$i) }',
                {"s": sess, "i": {"messageType": "RPC_BATCH_RESPONSE",
                                  "rpcBatchResponseMessage": {"batchId": c.get("batchId"),
                                                              "responses": resp}}}, "S")
        elif tn == "AI_RESPONSE":
            txt = c.get("content") or ""
            if txt:
                got_ai = True
                print("    AI_RESPONSE:", txt[:120])
        elif tn == "STATE_CHANGE":
            print("    STATE_CHANGE running=%s reach=%s" % (c.get("currentJobIsRunning"), c.get("backendReach")))
            if got_ai and not c.get("currentJobIsRunning"):
                break
        elif tn == "ERROR":
            print("    ERROR:", c.get("content"))
        elif tn:
            print("   ", tn)
    ws.close()
    print("\n结果:", "成功" if got_ai else "失败（看上面事件判断卡在哪一步）")


if __name__ == "__main__":
    main()
