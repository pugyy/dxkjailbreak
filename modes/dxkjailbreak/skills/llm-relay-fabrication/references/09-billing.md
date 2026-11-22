# 09 · 计费与对账

> 网关不记账，等于把自己的钱包交给上游。
> 这一篇管三件事：**算得准、对得上、能预警**。

## 一、口径先统一（这是所有错误的总根）

| 字段 | OpenAI Chat | OpenAI Responses | Anthropic |
|---|---|---|---|
| 总输入 | `prompt_tokens`（含缓存） | `input_tokens`（含缓存） | `input_tokens`（**不含**缓存） |
| 命中缓存 | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| 写缓存 | — | — | `cache_creation_input_tokens` |
| 输出 | `completion_tokens` | `output_tokens` | `output_tokens` |

**统一成三个内部数**（只在入口折算一次）：

```
uncached_input = 总输入 - 命中缓存           (Anthropic 直接用 input_tokens)
cached_input   = 命中缓存
output         = 输出
```

命中率 = `cached / (cached + uncached)`，**必须 ≤ 100%**。算出 232% 说明把"总输入"当成了"未命中"（真实事故，见 R-04）。

## 二、单价表（用相对倍数，别写死绝对价）

各家会调价，所以内部只存**倍数**，绝对价放配置：

```yaml
model_family: M
price_per_1m:
  input_uncached: 1.0
  input_cached:   0.1      # 读缓存通常 0.1x
  cache_write:    1.25     # Anthropic 写缓存 1.25x（5min TTL）
  output:         4.0      # 输出通常是输入的 4 倍
```

成本 = `uncached*1.0 + cached*0.1 + cache_write*1.25 + output*4.0`（除以 1e6 再乘单价）。

**为什么把 cache_write 单列**：只算 read 会低估成本。写缓存比普通输入还贵 25%，一冷一热差一倍。

## 三、账本结构（落盘，不能只在内存）

```json
{
  "totals":   {"req": 0, "uncached": 0, "cached": 0, "out": 0, "cost": 0, "err": 0},
  "perModel": {"M": {"req": 0, "uncached": 0, "cached": 0, "out": 0, "cost": 0}},
  "perNode":  {"n1": {"req": 0, "uncached": 0, "cached": 0, "out": 0, "cost": 0}},
  "perKey":   {"k1": {"req": 0, "cost": 0}},
  "minuteBuckets": {"2026-11-15T20:40": {"req": 0, "cost": 0}},
  "dayBuckets":    {"2026-11-15": {"req": 0, "cost": 0}}
}
```

**四份都要**：累计、按模型、按节点、分钟时序。
只存累计 → 重启面板全空（事故 R-05）；只存时序 → 算不出总量。

**写入节奏**：每 50 条请求或每 10 秒落一次盘，`writeFileSync` 到临时文件再 `rename`（原子写）。

## 四、请求级账本（要能查单条）

```json
{"rid":"a1b2","ts":1763200000000,"key":"k1","model":"M","node":"n1",
 "uncached":1200,"cached":8000,"out":300,"cost":0.0042,
 "status":200,"retry":0,"aborted":false}
```

保留 7 天，按 `rid` 可查。**排障时全靠它**：某条请求成本异常、某节点偷偷贵 3 倍，一查就知道。

## 五、六类"账面骗人"的来源（逐条查）

| 现象 | 根因 | 处置 |
|---|---|---|
| 本地统计 > 上游账单 | 重试把同一次请求记了两遍 | 账本按 `rid` 去重，`retry>0` 只记最终一次 |
| 本地统计 < 上游账单 | 流中断/客户端 abort 后上游仍计费 | `aborted=true` 也要记账（按已收 token 与上游 usage 之和） |
| 成本突增 2 倍但请求数没变 | 缓存失效，全走 uncached | 查 cache_read 是否为 0；查 system 前缀是否被动过 |
| 输出 token 明显偏小 | 流式 usage 只在最后一帧给，没取到 | 读流末尾的 usage 帧；OpenAI 需 `stream_options:{include_usage:true}` |
| 某些请求 usage 全 0 | 上游私有协议不带 usage | 本地按字符估算并标记 `est=true`，账单里单列 |
| 余额对不上但统计对得上 | 上游按"点数"计费且有隐藏折扣/赠送 | 以余额差为准反推单价，不要硬对 token |

**对账公式**（每天一次）：

```
上游余额减少额 ≈ 本地 cost 合计 × (1 ± 5%)
偏差 > 10%  → 查上面六类
偏差稳定在某个比例 → 说明单价配错了，按比例修正
```

## 六、预警阈值

```js
const GUARD = {
  hourlyCost:  <预算/24>,        // 超了就降级到便宜模型或拒新会话
  singleReqCost: <平均成本 × 20>, // 单请求异常（可能是 prompt 注入爆长）
  cacheRate:  0.7,               // 低于此值告警
  errRate:    0.05,              // 错误率超 5% 告警
  balanceLow: 0.1,               // 余额低于 10% 立刻告警（点数归零=静默超时）
};
```

**点数余额要单独看 `sufficient` 字段**，不是看 `balance` 数字。`balance: 0` 时 API 不报错，只是全部静默超时。

## 七、给客户端反推额度（做产品时要）

客户端只想知道"还能用多少"，所以网关要能算：

```
剩余额度 ≈ (上游余额 × 单价换算) − 本地已消耗
```

并提供 `/status`：

```json
{"req": 1234, "cost": 0.87, "cacheRate": 0.78,
 "perModel": {"M": 1200}, "balance": 12.4, "sufficient": true,
 "uptime": 3600, "lastError": null}
```

## 八、自检

```
□ 入口把三种协议的口径折成 uncached/cached/output 三数
□ cache_write 单独计（Anthropic 路径）
□ 账本落盘含 累计/按模型/按节点/分钟时序
□ 请求级账本可按 rid 查，retry 去重，aborted 也记
□ 每天对一次上游余额，偏差 >10% 有查法
□ 余额看 sufficient，不看 balance
□ /status 能给出成本、命中率、余额、错误率
```
