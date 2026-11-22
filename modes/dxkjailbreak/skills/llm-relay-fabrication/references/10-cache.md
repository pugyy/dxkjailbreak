# 10 · 缓存：三层，越往下越危险

> 反代加缓存，是把"省"和"出错"放在同一根绳上。
> 三层要分清：**上游前缀缓存（必做）、网关响应缓存（可做，有条件）、语义缓存（慎做）**。

## 一、层 1：上游前缀缓存（Prompt Cache）——必做

这是上游原生的，钱直接从账单里省，不需要你发明任何东西。

### 命中条件（四件事全对才有缓存）

1. **前缀逐字节相同**：system + tools + 历史消息的顺序、空格、字段名，一个字节都不能变
2. 前缀长度过门槛（OpenAI 1024 token 起，Anthropic 1024–2048 起）
3. 同一 `prompt_cache_key` 落在**同一节点**（跨节点前缀互不相认）
4. 在 TTL 内（OpenAI 5–10 分钟，Anthropic 5 分钟 / 1 小时两种）

### 三条工程动作

```js
// 1) 结构化固定前缀：把"不会变的东西"全部前置且顺序稳定
{ system: STABLE_SYSTEM,           // 一个字都别动
  tools:  STABLE_TOOLS_SORTED,     // 按 name 排序，别按用户输入顺序
  messages: [ ...history, userMsg ] }

// 2) 显式缓存标记（Anthropic）
messages[0].content = [{ type:"text", text: LONG_STABLE,
                         cache_control: { type:"ephemeral" } }];

// 3) 会话粘性键
cacheKey = sha256(model + system + firstUserMsg).slice(0,16)
// 同一 key 的请求固定打同一节点，30 分钟 TTL
```

### 反模式（前三条会直接废掉缓存）

- system prompt 里带时间戳 / 随机 id / 当前用户名 → 每次都不同，命中率永远 0
- tools 数组顺序随请求变化 → 前缀变了
- 每次请求把历史重新排序或重新格式化（`JSON.stringify` 键序不同）
- 只做均衡不做粘性 → 同会话被打到不同节点
- 只做粘性不做均衡 → 少数节点过载

## 二、层 2：网关响应缓存（可以做，但要四个前提）

网关把"问过的问题"的答案存下来，第二次直接返回。省钱、降延迟，**但错了就是串会话**。

### 前提一：只缓存确定性请求

```js
const cacheable = body.temperature === 0
  && !body.tools?.length          // 有工具调用绝不缓存（会产生副作用的语义）
  && !body.streamSafe === false
  && !body.messages?.some(m => m.role === "tool")
  && !body.seed                    // 或 seed 固定时反而可缓存
  && body.max_tokens <= 2048;      // 长输出不缓存，命中率低还占内存
```

**温度 > 0 一律不缓存**：同样的输入本来就该给不同答案，缓存等于把模型变成复读机。

### 前提二：缓存键必须包含"所有影响输出"的东西

```js
key = sha256(JSON.stringify({
  model,                       // 模型必须进 key
  modelVersion: upstreamVersion,  // 上游小版本变了要失效
  system,                      // 完整 system
  messages: normalized(messages),   // 归一化后的消息（键序固定）
  tools: normalized(tools),
  temperature, top_p, max_tokens, stop, response_format,
}))
```

**漏掉 model 就会串模型**（拿 A 模型的答案回 B 模型）；漏掉 system 就会串人设。

### 前提三：按调用方隔离（安全底线）

```js
key = sha256(apiKeyId + "\0" + payloadKey);   // 不同用户绝不共享缓存条目
```

跨用户共享缓存 = 别人的私有 prompt 结论进你的响应，是事故级问题。
真要跨用户共享，也只能共享**公共、无隐私**的内容（比如固定 FAQ 类的 system+问句），且要显式配置白名单。

### 前提四：命中要记账、要能失效

```js
{ hit: true,  cachedAt, ttl, hitCount }     // 命中记一次，成本记 0（或记 cache_read）
{ hit: false, stored }                       // 未命中才走上游
```

- TTL 建议 **5–30 分钟**（比上游前缀缓存稍长即可，别做天级）
- 失效触发：模型版本变更、system 变更、手动 `/admin/cache/flush`
- 命中率上限**不要追 100%**：追到 90%+ 通常意味着你在缓存不该缓存的东西

### 流式怎么缓存

流式请求也能缓存：把上游完整流收完，落成 `frames[]`（每帧原文），命中时按原间隔重放（或按 20ms 均匀重放）。

```js
// 落
{ frames: ["data: {...}\n\n", ...], totalMs, endedWith: "[DONE]" }
// 放
for (const f of frames) { res.write(f); await sleep(8); }
res.end();
```

**注意**：命中重放必须也发终止事件，且**不要**把 `ttft` 记成 0（记 `cacheHit=true`，延迟单独统计）。

### 网关缓存的验收

```
□ temperature>0 的请求不进缓存
□ 有 tools / tool 消息的请求不进缓存
□ key 覆盖 model + system + messages + 采样参数
□ 按 apiKeyId 隔离，跨用户不共享
□ 命中/未命中都记账，命中成本记 0
□ 能一键 flush，且模型版本变更自动失效
□ 流式命中能完整重放并带终止事件
```

## 三、层 3：语义缓存（慎做，只用于读类）

向量相似度匹配"意思一样的问题"。命中率能到 30–50%，**但答错率同样高**。

只在这一种场景用：**纯查询类、答案与用户无关、允许轻微不精确**（例如"这个模型的上下文窗口多大"）。

三条硬限制：

1. 相似度阈值 ≥ 0.95，且必须人工抽检样本
2. 用户身份相关的问句**一律不进语义缓存**
3. 命中后要在响应头标注 `x-cache: semantic`，让调用方可选择忽略

反代场景**默认关闭**。它省的是钱，赔的是信任。

## 四、三层怎么配合（推荐配置）

| 层 | 开关 | TTL | 命中率预期 | 风险 |
|---|---|---|---|---|
| 上游前缀缓存 | **必开** | 上游定 | 60–85% | 无 |
| 网关响应缓存 | 默认开（严格条件） | 5–30 min | 5–20% | 低（条件严格时） |
| 语义缓存 | 默认关 | — | 20–40% | 高 |

**缓存命中率不是越高越好**。上游前缀缓存看 70%+ 算健康；网关命中率长期 > 40% 要复核缓存键是不是漏了变量。

## 五、一个典型事故链（照着避）

```
现象：缓存命中率 95%，成本却涨了 3 倍
原因：网关缓存把 temperature=0.7 的请求也缓存了
     → 用户重复问同一个问题都拿到同一个答案
     → 用户不高兴，重问 5 次（以为没生效）
     → 每次重问都算一次请求，命中缓存成本记 0 但请求数暴涨
     → 面板命中率漂亮，账单难看
修：temperature>0 一律不缓存；命中率上限设 60% 告警
```

## 六、自检

```
□ 上游：system/tools 前缀稳定，无时间戳无随机
□ 上游：同会话粘性键 + 30min TTL，命中率 >70%
□ 网关：只缓存 temperature=0、无 tools、短输出
□ 网关：key 含 model + system + messages + 采样参数
□ 网关：按 apiKeyId 隔离
□ 网关：命中/未命中都记账，能 flush，版本变自动失效
□ 语义缓存默认关闭
```
