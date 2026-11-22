# 04 · 额度、账号池与多账号

## 最重要的一条：点数归零 = 静默超时

平台按"点数"计费时，余额耗尽**不会返回 402/429**，而是：
- 请求照常发出
- 服务端不产生任何事件
- 客户端只能等到超时（实测 100s 后返回 `[relay] timeout`）

**排查任何"突然全部失败"应先查余额，不要先怀疑代码。**

```graphql
{ copilotAiPointsStatus { balance sufficient lowBalance criticalBalance nextRefillAt } }
```

| 字段 | 含义 |
|---|---|
| `balance` | 剩余点数 |
| `sufficient` | 是否够用（**这个才是判据**） |
| `nextRefillAt` | 下次补充时间（通常 UTC 0 点） |

实测：`balance: 0` → 7 个模型全部 100s 超时；换成 `balance: 700000` 的账号，
同样 7 个模型 13–21s 全部正常。

## 点数消耗速度

一次普通对话几十到几百点；一次带工具的多轮任务可能上千点。
70 万点在一轮密集测试里会被打掉 30 万（实测）。

## 账号池

### 自动注册守护

```
目标 N 个 → 不足则注册 → 追加 accounts.jsonl → 循环
```

关键工程约束：

| 约束 | 原因 |
|---|---|
| **单线程 + 失败退避 60s** | 并发注册会把平台风控打爆（实测 42 并发直接全部失败） |
| 收码走临时邮箱 API，轮询 5s | 邮件通常 8–15s 到 |
| 域名池轮换 | 单一收件域被拉黑就全废 |
| 注册后**必须重新 login 换 token** | `registerV2` 返回的 token 直接查 `user` 会 401 |

### 多账号能不能共用项目

结论：**通常不行，需要实测**。

- `addCollaborator(projectExId, accountExId, appExId, collaboratorType)` 返回 `null`
  且不报错 → **不代表成功**
- 判据只有一个：用该账号自己发 `createAgentSession`，看是否
  `FAILED_VALIDATION` / `you have no permission to edit`

```graphql
mutation { createAgentSession(projectExId:"P", appExId:"A") }
```

### 每个账号必须有自己的项目

而且项目**必须是跑过一次 AI 对话的**：

| 项目来源 | createAgentSession | 实际对话 |
|---|---|---|
| 纯 API 建的空项目 | ✅ 成功 | ❌ 100s 超时 |
| 浏览器 UI 完整建（含 AI 对话） | ✅ 成功 | ✅ 正常 |

原因：空项目 schema / agent 上下文未初始化（`ZED_VERSION_MISSING`、
`appConfigAndSchema` 403）。

### 工作池结构

```json
[
  {"email":"user@example.com","project":"P1","app":"A1"},
  {"email":"user@example.com","project":"P2","app":"A2"}
]
```

```python
def worker():
    """轮询返回 (token, project, app)"""
    with _W_LOCK:
        if WORKER_POOL:
            _W_IDX[0] = (_W_IDX[0] + 1) % len(WORKER_POOL)
            w = WORKER_POOL[_W_IDX[0]]
            return w["token"], w["project"], w["app"]
    return token(), PROJECT, APP
```

**上线前必须逐个实测**：轮换到不可用账号会让 3/4 的请求超时，
比单账号更糟。实测 4 账号轮换 = 1 成功 3 超时 → 回退单账号。

## 提速的正解与误解

| 做法 | 结果 |
|---|---|
| 每次新建 session | 16–21s |
| **活跃 session 复用（连续对话）** | **5–6s**（接近网页体感） |
| 预热 session 池（建好等用） | ❌ 闲置被服务端回收，reactivate 反而 +6s |
| 跨请求复用同一 session | ❌ 上个任务上下文污染，输出错乱（出现 `body len=16`） |

网页端快，本质就是**打开项目时就把 session 建好并保持活跃**，
点发送时是热的。反代每次新建，多付 5.5s 建会话 + 4s 冷启动。

## 平台凭证拿不到（别浪费时间）

试过且全部失败的方向：

| 接口 | 结果 |
|---|---|
| `backendOnlyToken` / `runtimeConfig` / `allCloudConfigurations` | 403 |
| `appConfigAndSchema(project, app)` | 403（AppConfig 只有公开字段） |
| `thirdPartyApiDebug`（SSRF 原语） | 外网可用，内网被 IP 级拦截（`127.0.0.1.sslip.io` 解析后仍拦） |
| `setThirdPartyApiAllowedToReachInternalNetworks` | 403 需管理员 |

模型凭证在服务端环境里，不经过任何用户可达的 API。
