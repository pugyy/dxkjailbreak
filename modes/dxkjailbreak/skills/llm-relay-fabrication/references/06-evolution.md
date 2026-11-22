# 06 · 自进化：把事故变成规则

## 为什么需要

同一个坑会在不同平台重复出现。**没有沉淀，每次都在原地重蹈。**

本 skill 的进化机制：把每次踩坑压缩成一条**可检测的规则**，下次开工先读规则。

---

## 进化循环

```
事故 → 记录(LOG) → 归纳(规则) → 编译(RULES) → 前置检查(NEXT) → 回灌
  ↑                                                              │
  └──────────────────── 下次任务开始时读取 ←────────────────────┘
```

### 1. 事故发生时：立刻记 LOG

格式固定，不写流水账：

```markdown
## 2026-10-29 · 节点持续掉线

**症状**：节点池永远补不满，建了就被移除
**根因**：健康探针用的模型在免费计划下 403，每个节点都被判异常
**证据**：`probe 403 permission_error: model requires a paid plan`
**规则**：探针模型必须是当前账号能 200 的模型，不能用"最强模型"
**检测**：`grep -c 'probe 40[13]' pipeline.log` 应为 0
```

五个字段缺一不可：**症状、根因、证据、规则、检测**。

### 2. 定期归纳：LOG → 规则

同类事故出现第二次，就要升级成"硬规则"，写进 RULES：

```markdown
### R-01 探针模型选择
- 必须用最便宜的可用模型
- 每次换账号计划后重测
- 不要在探针里用旗舰模型
```

### 3. 编译：自动生成 RULES.md

```bash
node scripts/evolve.mjs compile
```

把 LOG 里所有"规则"字段抽出来，去重、分类、生成带编号的 RULES.md。

### 4. 前置检查：开工先跑

```bash
node scripts/evolve.mjs check
```

按 RULES 生成一张自检清单，逐条要证据。**没过的不许开工。**

### 5. 回灌：新坑反向 enrich skill

踩到全新类别的坑，除了记 LOG，还要往对应 reference 文档补一节。
这样 skill 本身在长大。

---

## 规则分类（用这个当标签）

| 标签 | 覆盖 |
|---|---|
| `probe` | 健康检查、存活判定 |
| `model` | 模型名、计划限制、可用性 |
| `auth` | 凭证、token 生命周期 |
| `protocol` | 字段翻译、协议识别 |
| `stream` | 流式、心跳、终止 |
| `cache` | 缓存打点、命中率、TTL |
| `usage` | 计量口径、持久化 |
| `sched` | 节点选择、粘性、均衡 |
| `retry` | 故障转移、状态码分类 |
| `ops` | 部署、systemd、nginx |
| `risk` | 风控、批量节奏、封号 |

---

## 已沉淀的硬规则（示例，来自真实事故）

```markdown
### R-01 [probe] 探针模型必须是"当前能 200 的模型"
症状：节点建好就被移除，池子永远补不满
检测：grep 'probe 40[13]' pipeline.log 应为空

### R-02 [model] builder 模型和探针模型必须同属"免费可用"
症状：建会话 403 model_requires_upgrade
检测：用目标模型单独发一次建会话请求，确认 200

### R-03 [usage] 上游 prompt_tokens 是"总输入"，不是"未命中"
症状：命中率算出 >100%
检测：cacheRead / tokensIn 应 ≤100%

### R-04 [usage] perModel 和 minuteBuckets 必须持久化
症状：每次重启面板图表全空
检测：重启后 /status 里 perModel 条数 >0

### R-05 [cache] 命中率 = cached / (cached + uncached)
症状：同上
检测：手工复算与接口值一致

### R-06 [risk] 批量操作必须有节奏控制
症状：账号批量 disabled / IP 被封
检测：每小时新增账号数有上限；建节点并发有上限

### R-07 [ops] 改任何一个"上游相关"配置后，必须重测三类请求
非流式 / 流式 / 工具调用，缺一不可
```

---

## 新平台启动检查单（照抄）

```
□ 读 RULES.md，逐条确认当前平台是否适用
□ 跑 scripts/probe-protocol.mjs 确认协议
□ 跑 scripts/check-relay.mjs 拿基线
□ 记录本平台的 PLAN_LAYERS（哪些模型免费，哪些付费）
□ 记录本平台的 PROBE_MODEL 和 BUILDER_MODEL
□ 写一条"平台画像"到 evolution/LOG.md
```

**平台画像模板**：

```markdown
## 平台画像 · <TARGET>
- 前端形态：WebView 壳 / RN / Flutter
- 认证：<IdP>，token 分层 <列表>
- 模型平面：A/B/C，选 B
- 免费模型：<列表>
- 付费模型：<列表>
- 探针模型：<X>
- builder 模型：<Y>
- 已知限制：<...>
```
