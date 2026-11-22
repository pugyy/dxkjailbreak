# 01 · 侦查：找到真正的接口

## 目标

在写任何代码之前，产出一份**可复现的 API 清单**：每个接口的 URL、方法、鉴权头、请求体形状、响应体形状。

## 步骤

### 1. 判定前端形态

```bash
# APK 解包
apktool d TARGET.apk -o out
ls out/assets/

# 关键文件
# index.android.bundle  → React Native / Expo
# manifest.json         → Expo 或 WebView 远程清单
# flutter_assets/       → Flutter
# www/                  → Cordova / Capacitor
```

| 发现 | 结论 | 下一步 |
|---|---|---|
| `index.android.bundle` 数 MB | RN/Expo，逻辑在包里 | 直接 grep bundle |
| `manifest.json` 里有 `bundleUrl` / `launchAsset` | WebView 壳 + 远程 bundle | **下载远程 bundle** |
| `assets/flutter_assets/` | Flutter | 先找远程配置 URL |

### 2. 找远程 bundle（WebView 壳的核心）

```bash
# 从 APK 里挖域名
strings TARGET.apk | grep -oE 'https?://[a-zA-Z0-9.-]+' | sort -u

# 常见形态
# https://cdn.TARGET/app/manifest-<rev>.json
# https://TARGET/assets/index-<hash>.js
```

manifest 里通常有版本号和 bundle 的相对路径，**跟着下载**：

```bash
curl -s https://cdn.TARGET/app/manifest.json | jq .
# 找 launchAsset.url 或 bundle.url
curl -sO https://cdn.TARGET/app/bundle.zip
unzip bundle.zip -d bundle/
```

### 3. 从 bundle 提取 API 表

```bash
# 路由
grep -oE '"/api/[a-zA-Z0-9/_-]+"' bundle/*.js | sort -u

# 完整 URL
grep -oE 'https://[a-zA-Z0-9./_-]+' bundle/*.js | sort -u

# 只看会发请求的
grep -oE '(fetch|axios|request)\([^)]{0,80}' bundle/*.js

# GraphQL 操作名
grep -oE 'query [A-Za-z]+|mutation [A-Za-z]+' bundle/*.js | sort -u
```

### 4. 抓包验证（不可跳过）

**bundle 里找到的路径必须用真实请求确认**。原因：bundle 可能包含灰度代码、废弃路由、A/B 分支。

```bash
# Android 证书固定时先上 frida 解 pin，或直接用 r0capture
# 桌面/Web 用 mitmproxy
mitmproxy -p 8080
```

**验证顺序**：
1. 先跑一次真实操作（登录 → 主要功能）
2. 记录**完整请求**（URL + header + body）
3. 用 curl 重放，确认能得到同样结果
4. 重放成功才算"这个接口可用"

### 5. 产出格式

```markdown
## API 清单

| # | 方法 | 路径 | 鉴权 | 请求体关键字段 | 响应关键字段 | 状态 |
|---|---|---|---|---|---|---|
| 1 | POST | /api/auth/login | 无 | email, password(加密) | token | ✅ 重放成功 |
| 2 | GET  | /api/user/info | Bearer | - | plan, quota | ✅ |
```

## 陷阱

- **只读 bundle 不抓包** → 把废弃路由当生产接口，浪费一整天
- **假设 URL 拼接规则** → 相对路径的 base 可能不是域名根，看 bundle 里的 `baseURL`
- **忽略 header 里的自定义字段** → 很多平台要 `x-<product>-*` 头才放行
- **用浏览器 UA 抓 Web，用 APK 抓 App** → 两套风控不同，凭证可能不通用

> 登录后能挖到的业务平面（额度/签到/邀请/账单/团队/Key 管理等 16 类）见 `12-asset-planes.md`。
