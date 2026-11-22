# 04 · 反代：把私有协议翻译成通用协议

## 目标

让**任意**标准客户端（Codex、Claude Code、opencode、Cursor、Continue、Ollama 客户端、Gemini CLI）都能指向你的网关，不需要它们改配置。

## 架构最小骨架

```
客户端
  │  任意协议
  ▼
┌─────────────────────────┐
│ 1. 协议识别（字段嗅探）   │
│ 2. 归一化（中间表示）     │
│ 3. 节点选择（粘性/均衡）  │
│ 4. 上游调用（含重试）     │
│ 5. 序列化回客户端协议     │
│ 6. 流式转发 + 计量        │
└─────────────────────────┘
  │
  ▼
上游节点（沙箱 / API）
```

## 1. 协议识别：按字段，不按路径

**同一个路径可能被不同客户端发不同协议**，所以必须嗅探 body：

```js
function sniff(body) {
  if (Array.isArray(body.input)) return "responses";        // OpenAI Responses
  if (Array.isArray(body.contents)) return "gemini";
  if (Array.isArray(body.messages)) {
    // 看是否 Anthropic 风格
    if (typeof body.system !== "undefined") return "anthropic";
    if (body.messages.some(m => Array.isArray(m.content))) return "anthropic";
    if (body.max_tokens && !body.max_completion_tokens) return "anthropic";
    return "openai";
  }
  if (typeof body.prompt !== "undefined") return "completions";
  return "openai";
}
```

**常见的判断错误**：

| 错误做法 | 后果 |
|---|---|
| 按路径 `/v1/messages` 判断 | Codex 会把 Anthropic 协议发到 `/v1/chat/completions` |
| 按 header `anthropic-version` 判断 | 有些客户端不发这个头 |
| 只看 `messages` 就用 OpenAI 处理 | Anthropic 的 `content` 是数组，直接拼字符串会炸 |

## 2. 归一化（四个必做项）

### messages

```
OpenAI:    content 是 string 或 [{type:text},{type:image_url}]
Anthropic: content 是 [{type:text},{type:image},{type:tool_use},{type:tool_result}]
Responses: input 是 [{role, content}] 或 [{type:"message",...}]

统一成： [{role, content: [{type:"text"|"tool_use"|"tool_result", ...}]}]
```

**必须处理的边界**：
- 连续同 role 消息 → 上游会 400，要合并
- 中间出现 system 消息 → 提到顶部
- 空 content → 补一个空 text，不能留空数组

### tools

```
OpenAI:    {type:"function", function:{name, description, parameters}}
Anthropic: {name, description, input_schema}
Responses: 两种混用，且可能嵌在 input[] 里
```

**最坑的一种**：某些客户端把 tools 塞进 `input[]` 里，形如

```json
{"type":"additional_tools","tools":[...]}
{"type":"namespace","tools":[{"type":"custom","name":"exec"}]}
```

必须递归展平，且 `custom` 类型的工具**接收原始文本而不是 JSON 对象**。

### usage

这是最容易错的地方，见 05 文档。核心：

```
OpenAI Chat:    prompt_tokens = 总输入（含缓存）
                completion_tokens = 输出
Anthropic:      input_tokens = 未命中部分（不含缓存）
                output_tokens = 输出
Responses API:  input_tokens = 总输入
```

**统一内部口径：`uncached_input` / `cached_input` / `output` 三个数**，在入口折算。

### 缓存字段（双向翻译）

| 上游给 | 要翻译成 |
|---|---|
| `cache_read_input_tokens`（顶层） | `prompt_tokens_details.cached_tokens`（Chat）<br>`usage.input_tokens_details.cached_tokens`（Responses）<br>`usage.cache_read_input_tokens`（Anthropic） |
| `prompt_tokens_details.cached_tokens` | 同上，按目标协议 |

## 3. 节点选择

两层策略：

```
第一层：粘性（保缓存）
  用 prompt_cache_key 或"首条消息 hash"做键，30 分钟 TTL
  同一会话永远打同一节点 → 前缀缓存不失效

第二层：均衡（保覆盖）
  新会话按 (done 升序, busy 升序, 轮询) 三级排序
  保证每个节点至少吃到 1 个请求
```

**为什么两级都要**：只粘性 → 少数节点过载；只均衡 → 缓存全废。

## 4. 上游调用与重试

```js
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

for (let i = 0; i < MAX_TRY; i++) {
  const node = pickNode(exclude);
  const r = await fetch(node.url, {...});
  if (r.ok) return r;

  if (RETRYABLE.has(r.status)) {
    markCooldown(node, 60_000);   // 冷却，别立刻再挑它
    exclude.push(node.id);
    continue;                      // 换节点重试
  }
  throw r;                         // 4xx 不重试，直接透出
}
```

**铁律**：`401/403/400/404` **不要重试**。重试只会把所有节点都打一遍，浪费时间且可能触发风控。

## 5. 流式转发（必须真流式）

```js
res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",        // 关键：让 nginx 不缓冲
});

// 心跳：空闲超过 10 秒就发注释行，防中间层超时断连
const hb = setInterval(() => res.write(": ping\n\n"), 12_000);

// 客户端断开 → 中止上游，别让上游白跑
const ac = new AbortController();
res.on("close", () => ac.abort());
```

## 6. 常见错误与后果

| 错误 | 症状 |
|---|---|
| 上游是流式但网关先缓冲成 JSON 再发 | 客户端收不到 token，看着像卡死 |
| 忘记发终止事件（`[DONE]` / `response.completed`） | 客户端报 `stream disconnected before completion` |
| `res.writeHead` 在拿到上游响应前就调用 | 上游 4xx 时无法改状态码，客户端看到 200 + 空流 |
| 客户端断开不中止上游 | 上游继续跑完，白烧额度 |
| 不设 `X-Accel-Buffering: no` | 经过 nginx 后流被攒成一坨 |

## 7. 最小可用清单

```
□ 5 种协议入口都能识别
□ messages / tools / usage 三类字段双向翻译正确
□ 流式真流式，有心跳有终止
□ 429/5xx 换节点重试，4xx 直接透出
□ 粘性 + 均衡两级选节点
□ 客户端断开中止上游
```
