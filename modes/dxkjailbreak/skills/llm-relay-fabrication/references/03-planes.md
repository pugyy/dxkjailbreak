# 03 · 建模：找对"模型平面"

## 核心判断

同一个 AI 平台通常有 **3~5 个独立的模型平面**，它们的凭证类型、计量方式、稳定程度完全不同。选错平面 = 后面全部返工。

## 平面矩阵

先填这张表，再决定做哪个：

| 平面 | 探测方法 | 凭证 | 稳定性 | 计费 |
|---|---|---|---|---|
| A 公开推理 | `/v1/chat/completions`、`/v1/messages` | API key 或私钥签名 | 高 | 按 token |
| B Agent/沙箱 | `/session`、`/workspace`、`/project` | 用户 token → 签发 llm_key | 中 | 按 token，倍率不同 |
| C 媒体生成 | `/media/*`、`/images/*`、`/video/*` | 同 B | 中 | 按次 |
| D 内部配置 | `/api/config`、`/api/settings` | 沙箱 accessKey | 低 | 无 |
| E 调试/后台 | `/admin/*`、`/internal/*` | 管理员 | 低 | 无 |

## 选型规则

```
优先级：B（沙箱平面）> A（公开平面）> C（媒体）
理由：
  B 能给标准 LLM key，能被本地任意进程使用，不绑定前端
  A 常常要私钥签名，签名逻辑在客户端里，迁移成本高
  C 只解决特定需求
```

## 平面 B 的完整链路（最常用）

```
1. 用户登录           → id_token
2. 建会话/沙箱         → accessKey + httpUrl + wsUrl
3. 读沙箱配置          → models 列表（含空 api_key）
4. PATCH base_url      → 指向收集器
5. 触发一次模型调用    → 收集器收到真实 llm_key
6. 用 llm_key 直打     → /v1/messages 或 /v1/chat/completions
```

**关键观察**：沙箱配置里的 `models` 列表**往往包含比"当前计划允许"更多的模型**。

```
配置里有：claude-*, gpt-*, gemini-*, auto
实际可调：取决于账号计划
```

**做法**：配置里有的都试一遍，用真实响应 200/403 判定可用性，不要靠配置推断。

## 模型可用性探测（标准动作）

```bash
for M in $(curl -s "$HU/api/config?access_key=$AK" | jq -r '.models[].model'); do
  CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' "$HU/v1/chat/completions" \
    -H "Authorization: Bearer $LLM_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
  echo "$M -> $CODE $(head -c 80 /tmp/r.json)"
done
```

产出这样一张表：

```markdown
| 模型 | 状态 | 备注 |
|---|---|---|
| model-a | 200 | 可用 |
| model-b | 403 model_requires_upgrade | 需升级计划 |
| model-c | 404 not configured | 模型名不对 |
```

## 计划分层（非常重要的现实约束）

平台几乎都会分层：

```
免费计划  → 只给最便宜的几个模型
付费计划  → 全模型解锁
```

**不要假设"能建会话就能调所有模型"**。这两件事在不同层校验：

```
建会话校验：builder_model 是否在当前计划内
推理校验：  请求的 model 是否在当前计划内
```

**结果**：可以用免费模型建会话，但会话里调高价模型仍然 403。

## 陷阱

- **用最强模型做 builder** → 计划一收紧，建会话直接 403，整个池子崩
- **用最强模型做健康探针** → 同理，所有节点被判死
- **只看配置列表不看实际响应** → 以为有 10 个模型，实际只有 3 个能调
- **忽略 credit_multiplier** → 不同模型倍率差 6 倍，选错成本差 6 倍
- **假设模型名在配置和推理两处一致** → 配置里叫 `x_y`，推理要 `bedrock_x_y`，名字对不上就 404
