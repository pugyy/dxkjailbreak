# 07 · 运维面：后台任务与日志监控

> 长任务跑起来就没人看着，是反代和注册机最常见的死法。
> 这一篇只讲一件事：**让任务在后台跑，让日志替你看，让数字说话。**

## 一、三条铁律

1. **超过 60 秒的活儿一律后台跑**，不要占着交互通道等。
2. **每 10 秒看一眼日志**，不是跑完才看。跑完才看 = 白跑。
3. **每轮必须有一行可判读的数字**（成功数/失败数/速率/耗时）。没有数字的日志等于没有日志。

## 二、后台任务的四种开法

### 2.1 DSH 侧（当前环境）

```text
# 起后台任务，立刻拿 job id
bash:  <长命令>   run_in_background: true     -> job_id
pwsh:  <长命令>   run_in_background: true     -> job_id

# 读取（since last read，天然就是 tail）
job_output(job_id)                    # 立刻取增量
job_output(job_id, wait=true, timeout_ms=60000)   # 阻塞等，真被卡住才用

# 收尾
job_output(job_id)                    # 必须把这个 job 收干净再交结论
job_kill(job_id, reason="...")        # 不再需要的后台任务一定杀掉，别留幽灵
```

**纪律**：开了后台任务就记下 job_id；同一个任务不要重复起（会双跑、双计费、双注册）；给最终答复前必须把所有相关 job 收齐或杀掉。

### 2.2 opencode / 裸 shell

```bash
# Linux/macOS
nohup node relay.mjs >> run/relay.log 2>&1 &
echo $! > run/relay.pid
tail -f run/relay.log | grep -E 'level=error|slow|429|429|5[0-9]{2}'

# Windows（PowerShell）
$p = Start-Process node -ArgumentList 'relay.mjs' -RedirectStandardOutput run\relay.log -RedirectStandardError run\relay.err -PassThru
$p.Id | Out-File run\relay.pid
Get-Content run\relay.log -Wait -Tail 50
```

## 三、日志怎么打（结构化，别打散文）

### 3.1 每条请求一行 JSON

```js
log({
  ts: Date.now(),
  rid,                    // 请求 id，全链路同一串
  route: "/v1/chat/completions",
  proto: sniffed,         // openai | anthropic | responses | gemini | completions
  model, node: node.id,
  session: cacheKey?.slice(0, 8),   // 粘性键前缀
  status, ttft_ms, total_ms,
  in_tok: u.uncached, cache_read: u.cached, out_tok: u.output,
  cache: hit ? "hit" : "miss",
  err: err?.code,         // 只记 code，不记整段栈
});
```

**必须有的七个字段**：`rid`、`proto`、`node`、`status`、`ttft_ms`、`in_tok/cache_read/out_tok`、`err`。
少一个，出问题就没法归因。

### 3.2 分级与采样

| 级别 | 打什么 | 采样 |
|---|---|---|
| error | 4xx/5xx、上游异常、流中断、RPC 回执超时 | 全量 |
| warn | 429、节点冷却、缓存未命中且预期命中、TTFT > 3s | 全量 |
| info | 每条请求一行（上面那行） | 全量，但只留 7 天 |
| debug | 上游原始报文头、payload 长度 | 默认关，排障时按 `rid` 打开 |

**不要**把 prompt 正文、token 明文、邮箱密码写进日志。要排查就记 `sha256(prompt).slice(0,8)`。

### 3.3 日志轮转（不轮转 = 迟早写爆盘）

```js
const MAX = 200 * 1024 * 1024;   // 200 MB
const KEEP = 500;                // 保留最后 500 行
// 每次写前 statSync，超限就截断尾部重写
```

## 四、盯什么（看板四块）

| 块 | 指标 | 红线 |
|---|---|---|
| 吞吐 | req/min、并发数、队列长度 | 队列 > 20 说明上游被打满 |
| 延迟 | p50/p95 TTFT、p95 总耗时 | TTFT p95 > 3s 要查节点/缓存 |
| 错误 | 按 status 分桶（401/403/404/429/5xx） | 401 涨=凭证过期；429 涨=限流层 |
| 成本 | 每小时 token 消耗、缓存命中率、单请求均成本 | 命中率 < 70% 或成本突增 2 倍 |

**一条命令看全部**：

```bash
tail -n 2000 run/relay.log | jq -r '[.status,.proto,.node]|@tsv' | sort | uniq -c | sort -rn | head
tail -n 2000 run/relay.log | jq -s '[.[]|.ttft_ms] | sort | .[length*0.5|floor], .[length*0.95|floor]'
tail -n 2000 run/relay.log | jq -s '{req:length, cache:(map(select(.cache=="hit"))|length)} | . + {rate: (.cache/.req*100|floor)}'
```

## 五、任务进行中的标准节奏

```
T+0    起后台任务 job_id=xxx，同时 tail 日志
T+10s  一行进度：成功 N / 失败 M / 速率 R/min
T+60s  检查错误分类桶；某个桶突然涨就停手查那类
T+5m   报一次成本（token/请求数/命中率）
收尾   收 job_output → 汇总 → 杀 job → 结论三件套
```

**四个"立刻停手"信号**：

1. 401 突然占多数 → 凭证坏了，继续跑只是把节点全打成冷却
2. 429 集中出现 → 打到分组级限流了，降速或换组
3. 全部请求静默超时（无 error、无响应）→ **先查余额**，不是查代码
4. 日志里同一个 rid 出现两次 → 重试逻辑有 bug，会双倍计费

## 六、自检

```
□ 每个长任务都有 job_id 且记录在案
□ 每条请求日志有 rid / proto / node / ttft / 三数 token
□ 日志有轮转，不会写爆盘
□ 有 p95 延迟与错误分桶的现成命令
□ 出现 401/429/全超时/重复 rid 会立刻停手
□ 交付前 job 已收齐或杀掉
```
