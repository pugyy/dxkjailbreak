# 05 · 完美反代：四项验收

"能跑通"和"和真品一样"之间差四项。逐项验收，不过不算完成。

---

## 一、真流式

### 判定方法

```bash
curl -N -s http://GATEWAY/v1/chat/completions \
  -H 'Authorization: Bearer KEY' -H 'Content-Type: application/json' \
  -d '{"model":"M","stream":true,"messages":[{"role":"user","content":"数到50"}]}' \
  | while IFS= read -r line; do printf '%s %s\n' "$(date +%S.%N)" "$line"; done
```

**合格标准**：

```
□ 时间戳递进（不是同一秒内全部到达）
□ 每个 chunk 是完整 SSE 帧（data: {...}\n\n）
□ 结尾有终止事件（[DONE] 或 response.completed 或 message_stop）
□ 空闲超过 12 秒时能看到 ": ping" 心跳
```

### 常见错法

| 错法 | 表现 |
|---|---|
| 先收完再一次性发 | 所有时间戳相同 |
| 只发 data 不发双换行 | 客户端解析不出帧 |
| 不发终止事件 | 客户端报 stream disconnected |
| 经过 nginx 未关缓冲 | 流被攒成一批 |

### 必做的三件事

```js
// 1. 心跳
const hb = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 12000);

// 2. 终止兜底（无论成功失败都要发）
try { /* 转发 */ } finally {
  if (!terminalSent) res.write("data: [DONE]\n\n");
  clearInterval(hb);
  res.end();
}

// 3. 断开联动
res.on("close", () => upstreamAbort.abort());
```

---

## 二、真缓存

### 判定方法

同一个大 prompt（>1024 token）连续发两次，比对 usage：

```bash
for i in 1 2; do
  curl -s http://GATEWAY/v1/chat/completions -H "Authorization: Bearer KEY" \
    -H 'Content-Type: application/json' \
    -d '{"model":"M","max_tokens":10,"prompt_cache_key":"probe-1","messages":[{"role":"system","content":"<长文本>"},{"role":"user","content":"hi"}]}' \
    | jq '.usage'
done
```

**合格标准**：

```
第一次: cached = 0        （冷启动，正常）
第二次: cached ≈ 全部前缀  （命中率应 >90%）
```

### 命中率算法（必须对）

```
cached_input  = 上游给的 cached tokens
uncached_input = 上游给的总输入 - cached_input

命中率 = cached_input / (cached_input + uncached_input)
```

**绝对不要写** `cached / uncached`。这个错误会让命中率算出 >100%。

### 缓存必须显式打点（Anthropic 系）

```js
// 最多 4 个断点，建议 3 个
system: [{ type: "text", text: longSystem, cache_control: { type: "ephemeral" } }]
tools: [...tools, /* 最后一个工具加 cache_control */]
messages: [..., { role: "user", content: [{ type: "text", text: last, cache_control: {type:"ephemeral"} }] }]
```

**门槛**：前缀必须先达到 **1024 token** 才会被缓存。小于这个数，`cache_creation_input_tokens` 恒为 0。

### TTL 与粘性

```
默认 TTL 决定了"停顿多久后缓存失效"
实测常见区间：1~5 分钟

对策：粘性路由，让同一会话始终命中同一节点的缓存
```

### 诊断表

| 现象 | 原因 |
|---|---|
| cached 恒为 0 | 没打 cache_control / 前缀不足 1024 token |
| 第一次命中第二次不中 | 换了节点（粘性失效） |
| 间隔 2 分钟就失效 | TTL 到期，属正常 |
| 命中率 >100% | 算法错，用了 cached/uncached |

---

## 三、真工具

### 判定方法

发一个必须调工具的请求，检查往返：

```bash
# 第一轮：模型应返回 tool_use
curl -s ... -d '{"model":"M","messages":[{"role":"user","content":"读一下 /tmp/x"}],
  "tools":[{"name":"read","description":"read file","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]}'
# 期望：stop_reason = tool_use，带 tool_use block

# 第二轮：回传 tool_result
curl -s ... -d '{"messages":[...,{"role":"assistant","content":[tool_use]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"文件内容"}]}]}'
# 期望：200，模型继续
```

### 合格标准

```
□ tool_use 能返回，参数是合法 JSON
□ tool_result 能回传，不 400
□ custom 类型工具（接收原始文本）也能跑
□ 工具超过 10 个时不丢
```

### 常见的 400 原因

| 400 原因 | 修法 |
|---|---|
| 连续同 role 消息 | 合并相邻同类消息 |
| 中间夹 system | 提到顶部 |
| tool_call_id 重复 | 去重，保留最后一个 |
| assistant 有 tool_calls 但无对应 tool 消息 | 补一条空的 tool 结果 |
| `custom` 工具被当 function 传 | 递归展平，`custom` 单独处理 |

---

## 四、真计量

### 判定方法

```bash
# 记录改造前的统计
BEFORE=$(curl -s http://GATEWAY/status | jq .stats)

# 发一个已知 token 数的请求
curl -s http://GATEWAY/v1/chat/completions ... 

# 对比增量
AFTER=$(curl -s http://GATEWAY/status | jq .stats)
```

**合格标准**：

```
□ 增量 == 上游返回的 usage（误差 <1%）
□ 命中率 = cached / (cached + uncached)
□ 重启服务后统计不归零
□ 按模型/按分钟的分解数据重启后仍在
```

### 必须持久化什么

```
累计：requests / errors / tokens_in / tokens_out / cache_read / cache_write
分解：perModel { req, in, out, cached, err }
时序：minuteBuckets [{ t, req, err, in, out, cached }]
```

**只持久化累计是不够的** —— 面板的图表全靠后两项，重启就空白。

### 延迟分位数

```js
const ring = [];              // 最近 300 次
function record(ms) { ring.push(ms); if (ring.length > 300) ring.shift(); }
function pct(p) { const s=[...ring].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.round(p/100*(s.length-1)))]; }
```

采样点要打在**真实上游调用**外面，不要打在 HTTP 处理入口（否则把排队时间也算进去）。

---

## 五、总验收表

```
□ 流式：时间戳递进 + 有终止 + 有心跳
□ 缓存：第二次命中率 >90%，算法为 cached/(cached+uncached)
□ 工具：tool_use 往返 200，custom 类型也能跑
□ 计量：增量与上游一致，重启不丢，p50/p95 有值
□ 故障转移：429/5xx 换节点，4xx 秒回
□ 粘性：同会话不跨节点
□ 均衡：每个节点至少吃到 1 个请求
```

七项全绿，才算"完美反代"。
