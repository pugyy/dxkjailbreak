# 08 · SSE 深挖：真流式到底怎么做

> "能吐字"和"真流式"是两件事。
> 这一篇把 SSE 从帧格式到边界情况全摊开，照着验证就不会上线空包。

## 一、协议最小知识（够用版）

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no          ← 少了这条，nginx 会把流攒成一坨

```

**帧格式**（一个空行结束一帧）：

```
data: {"delta":"你"}\n\n          ← 默认事件
event: ping\ndata: {}\n\n         ← 具名事件
id: 42\nretry: 3000\n\n           ← 断线重连提示
: comment\n\n                     ← 注释行，最常用作心跳
```

**三条硬规则**：

1. 分隔符是 `\n\n`（不是 `\n`）。少一个 `\n` 客户端就一直等。
2. 每个 `data:` 行内部的 JSON 必须是**完整可解析**的；不能把半个对象拆到两帧。
3. 结束必须有**终止事件**，否则客户端报 `stream disconnected before completion`。

## 二、五种协议的终止与事件名

| 协议 | 流内事件 | 终止标志 |
|---|---|---|
| OpenAI Chat | `data: {choices:[{delta:{...}}]}` | `data: [DONE]` |
| OpenAI Responses | `event: response.output_text.delta` 等 | `event: response.completed` |
| Anthropic | `event: message_start` / `content_block_delta` / `message_delta` / `message_stop` | `message_stop` |
| Gemini | `data: {candidates:[{content:{parts:[{text}]}}]}` | 收到 `finishReason` 后关流 |
| 私有 RPC/WS（agent 平面） | 自定义 `AI_RESPONSE{delta}` | 自有 `STATE_CHANGE running=false` |

**翻译层的活**：入站是哪套、出站必须是哪套，**终止事件要按出站协议发**。
把 Anthropic 的 `message_stop` 直接透给 OpenAI 客户端 → 客户端一直等 `[DONE]`，表现为"说完话不结束"。

## 三、UTF-8 跨 chunk：最隐蔽的乱码源

网络 chunk 边界不认字符边界。`你` 的 UTF-8 是 `E4 BD A0`，可能被切成 `E4 BD` + `A0`。

```js
// 错：直接 toString
onChunk(buf => send(buf.toString("utf8")));     // 半个字 → U+FFFD

// 对：流式解码器保持状态
import { StringDecoder } from "node:string_decoder";
const dec = new StringDecoder("utf8");
onChunk(buf => { const s = dec.write(buf); if (s) handle(s); });
onEnd(() => { const tail = dec.end(); if (tail) handle(tail); });
```

**验证**：让模型连续输出中文，抓 `xxd` 看有没有 `EF BF BD`（U+FFFD）。有就是拆错了。

## 四、心跳：中间层超时的唯一解

任何一级代理（nginx / 云 LB / Cloudflare / 客户端）都可能 30–100s 空闲超时。

```js
const hb = setInterval(() => {
  if (!res.writableEnded) res.write(": ping\n\n");   // 注释行，客户端忽略
}, 12_000);
res.on("close", () => clearInterval(hb));
```

**参数怎么定**：心跳间隔 = 最严的那一级超时 ÷ 3。
Cloudflare 免费版 100s → 心跳 12–15s 最稳。企业 LB 常见 60s → 心跳 10s。

**注意**：心跳必须在**最后一个字节发出之前**停下，否则客户端会看到尾部垃圾。

## 五、背压：慢客户端会拖死网关

`res.write()` 返回 `false` 表示缓冲满。不处理就会内存暴涨。

```js
if (!res.write(chunk)) {
  await new Promise((r) => res.once("drain", r));
}
```

同时**上游要能被打断**：

```js
const ac = new AbortController();
res.on("close", () => {
  ac.abort();                       // 客户端走了，别让上游继续烧 token
  clearInterval(hb);
});
const up = await fetch(node.url, { signal: ac.signal, ... });
```

**不 abort 的代价**：用户按了停止，上游继续跑完 → 你照样付钱，且统计对不上。

## 六、错误发生在流中间怎么办

已经 `writeHead(200)` 之后才发现上游 500，**状态码改不了了**。正确做法：

```js
// 1) 尽力保持 200，用协议内的错误帧表达
res.write(`event: error\ndata: ${JSON.stringify({code, message})}\n\n`);
res.write("data: [DONE]\n\n");        // 或 message_stop
res.end();

// 2) 绝对不要：什么都不发直接 end()      → 客户端报 unknown error
// 3) 绝对不要：把 200 改成 500 再 writeHead → 抛 ERR_HTTP_HEADERS_SENT
```

**先在拿到上游首字节后再 flush 头**，是避免这个坑的唯一办法：

```js
const up = await fetch(...);                       // 等响应头
if (!up.ok) return replyStatus(res, up.status);    // 这时还能改状态码
res.writeHead(200, streamHeaders);
for await (const chunk of up.body) res.write(chunk);
```

## 七、超时与重试的边界

| 阶段 | 超时 | 重试 |
|---|---|---|
| 连接上游 | 10s | 可（换节点） |
| 首 token（TTFT） | 60s | 可（换节点，但要先确认上次没真的开始跑） |
| 流中空闲 | 45s（有心跳情况下） | **不可**（已经吐字了，重试会重复内容） |
| 总时长 | 10min 上限 | 不可 |

**铁律**：只要已经向客户端输出过内容，**任何重试都是错的**——用户会看到重复或错乱。宁可报错收尾。

## 八、SSE 验收（六条，逐条给证据）

```
□ 客户端能看到 token 逐个到达（录屏或 curl -N 时间戳）
□ 空闲 30s 连接不断（心跳生效）
□ 结尾有终止事件（[DONE] / message_stop / response.completed）
□ 中文不乱码（xxd 里无 EF BF BD）
□ 客户端断开后上游被 abort（日志里 up_aborted=true，token 不再增长）
□ 上游 500 时客户端收到可读错误，不是空流
```

**curl 一条命令验**：

```bash
curl -N -sS http://HOST/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer KEY' \
  -d '{"model":"M","stream":true,"messages":[{"role":"user","content":"用中文数到二十"}]}' \
  | while IFS= read -r l; do printf '%s %s\n' "$(date +%T.%3N)" "$l"; done | tee sse.raw
# 再看：末尾有没有 [DONE]；时间戳是否递增（不是一次性刷出来）
```

Python 侧验（要判断"是不是真逐帧到"）：

```python
import time, requests
t0 = time.time()
with requests.post(url, json=body, headers=h, stream=True) as r:
    for line in r.iter_lines():
        if line: print(f"{time.time()-t0:6.3f}s  {line[:80]!r}")
```

## 九、常见错误对照表

| 现象 | 根因 | 修 |
|---|---|---|
| 客户端"卡死"不吐字 | 网关先缓冲成 JSON 再发 | 边收边 forward，加 `X-Accel-Buffering: no` |
| 说完话不结束 | 缺终止事件，或发的是别的协议的终止 | 按出站协议补 `[DONE]`/`message_stop` |
| 中文偶发乱码 | chunk 边界拆了多字节字符 | `StringDecoder` / `TextDecoder({stream:true})` |
| 长回答断在 60~100s | 中间层空闲超时 | 12s 心跳 |
| 客户端看到 200 + 空体 | 上游 4xx 时头已经 flush | 拿到上游响应头后再 `writeHead` |
| 内存缓慢涨到 OOM | 没处理背压 | `drain` 等待 |
| 用户停止后 token 还在烧 | 没 abort 上游 | `res.on("close", () => ac.abort())` |
| 首字延迟 5s+ | 每次新建上游会话（agent 平面常见） | 见 `agent-plane-relay` 的 session 复用 |
