// dxkjailbreak · by dxk
// 设置控制台渲染实现（由 client.js 通过 settings.section 槽位挂载）。
//
// 实现原则：
//  - 多路探测宿主 settings API；探测不到 → 静默降级，绝不阻塞启动
//  - 不做全屏 overlay、不做免责门、不做侧栏挂件
//  - 所有操作走服务端 console-api（同源 /dxkjailbreak/console），前端只渲染
//  - 结构化渲染（卡片/表格/色标），不再裸 dump JSON；破坏性操作必须二次确认

const PLUGIN_ID = "dxkjailbreak";
const SECTION_TITLE = "dxkjailbreak";
const FALLBACK_VERSION = "1.3.0";

async function callApi(api, method, args) {
  try {
    // ① 宿主若注入了服务对象，优先走它（无 HTTP，最快）
    if (api && typeof api[method] === "function") return await api[method](...args);
    if (api && typeof api.call === "function") return await api.call(method, ...args);
    // ② 否则走本机同源 HTTP（设置页的标准通道）。
    //    服务端有同源栅栏（Origin / Sec-Fetch-Site 校验），跨站页面调不动。
    const readOnly = method === "status" || method === "patches" || method === "audit" || method === "checkPluginUpdate";
    const response = await fetch("/dxkjailbreak/console", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args: Array.isArray(args) ? args : [] }),
      signal: readOnly && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(20000) : undefined,
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).error || ""; } catch { /* 非 JSON */ }
      return { ok: false, error: "控制台请求失败（HTTP " + response.status + "）" + (detail ? "：" + detail : "") };
    }
    return await response.json();
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "请求超时，请重试。" : String(error?.message || error) };
  }
}

// ── DOM 小工具 ──────────────────────────────────────────────
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") node.textContent = v;
    else if (k === "className") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k === "onclick" && tag === "button" && typeof v === "function") {
      node.addEventListener("click", async (event) => {
        if (node.disabled) return;
        const view = node.closest?.(".dxkjailbreak-console");
        node.disabled = true;
        try { await v(event); }
        catch (error) {
          const banner = view?.querySelector('[role="alert"]');
          if (banner) { banner.textContent = "操作失败：" + (error?.message || String(error)); banner.hidden = false; }
        } finally { node.disabled = false; }
      });
    } else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const C = {
  muted: "opacity:.6",
  card: "border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:8px 10px;min-width:0;flex:1 1 150px;overflow-wrap:anywhere",
  cardLabel: "font-size:11px;opacity:.62;letter-spacing:.02em",
  cardValue: "font-size:16px;font-weight:600;margin-top:2px;word-break:break-all",
  row: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;min-width:0",
  table: "width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed",
  th: "text-align:left;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.3);font-weight:600;opacity:.85",
  td: "padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.12);vertical-align:top;min-width:0;overflow-wrap:anywhere;word-break:break-word",
  btn: "padding:4px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;cursor:pointer;font-size:12px",
  btnDanger: "padding:4px 10px;border-radius:6px;border:1px solid color-mix(in srgb,var(--dxk-bad) 60%,transparent);color:var(--dxk-bad);background:transparent;cursor:pointer;font-size:12px",
  input: "padding:4px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;font-size:12px;min-width:220px",
  pre: "white-space:pre-wrap;max-height:240px;overflow:auto;background:rgba(0,0,0,.18);padding:8px;border-radius:6px;margin:6px 0 0",
  badge: "display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;line-height:17px;border:1px solid",
  sect: "font-weight:700;margin:10px 0 6px 0;font-size:13px",
};
function badge(text, colorOrKind) {
  // 语义类别走 CSS 类（深色自动切换）；颜色串走 inline（兼容既有调用）
  const kind = STATUS_KIND[colorOrKind];
  if (kind) return el("span", { text, className: `dxk-badge-${kind}`, style: `${C.badge};opacity:.95` });
  return el("span", {
    text,
    style: `${C.badge} color:${colorOrKind};border-color:${colorOrKind};opacity:.95`
  });
}
/** 状态→语义类别：着色由 CSS 类 + 变量承担（深色自动适配），不再 inline 硬编码色 */
const STATUS_KIND = {
  applied: "ok", already: "ok",
  pending: "warn",
  broken: "bad", partial: "bad", drifted: "drift", unmatched: "bad",
  unlocated: "muted", missing_file: "muted", not_applicable: "muted",
  na: "muted", skipped: "muted", disabled: "muted", off: "muted", not_needed: "muted",
  unknown: "info",
};
/** 兼容旧引用：STATUS_COLOR 仍返回颜色串（供非 badge 场景的 inline 用） */
const STATUS_COLOR = new Proxy({}, { get: (_, k) => `var(--dxk-${STATUS_KIND[k] || "info"})` });
const STATUS_LABEL = {
  applied: "已打", already: "已打", pending: "待打", broken: "失配", partial: "部分命中",
  drifted: "已漂移", unmatched: "未命中",
  unlocated: "未定位", missing_file: "目标缺失", not_applicable: "不适用",
  na: "不适用", skipped: "跳过", disabled: "已禁用", off: "关闭", not_needed: "无需", unknown: "未知",
};

function card(label, value, sub, valueColor) {
  return el("div", { className: "dxk-card", style: C.card }, [
    el("div", { text: label, style: C.cardLabel }),
    el("div", { text: String(value), style: C.cardValue + (valueColor ? ";color:" + valueColor : "") }),
    sub ? el("div", { text: sub, style: C.muted + ";font-size:11px;margin-top:2px" }) : null,
  ]);
}

function table(headers, rows, renderRow) {
  if (!rows || rows.length === 0) return el("div", { text: "（暂无数据）", style: C.muted });
  const grid = el("table", { style: C.table + (headers.length > 4 ? ";min-width:" + (headers.length * 64) + "px" : "") }, [
    el("thead", {}, [el("tr", {}, headers.map(h => el("th", { scope: "col", text: h, style: C.th })))]),
    el("tbody", {}, rows.map((r, i) => el("tr", {}, renderRow(r, i)))),
  ]);
  return el("div", { role: "region", tabindex: "0", "aria-label": headers.join("、"), style: "overflow-x:auto;max-width:100%" }, [grid]);
}

// ── 控制台主体 ──────────────────────────────────────────────
let nextPanelId = 0;

// ── settingsScope 服务补齐 ──────────────────────────────────────────────
// 宿主 0.2.1-rc.2 的 web 客户端没有 settingsScope（0.1.6 设置页重构时移除），
// 而侧插件 client 声明 inject: ["slots", "settingsScope"]，缺了就一直 pending，
// web boot 直接判定启动失败。这里由主控台补一个等价实现：
// bind(namespace) → { getSnapshot, subscribe, set }，值存 localStorage，
// 快照 mode 标 "memory"（不接宿主设置通道），解码失败按 fail-open 处理。
var SETTINGS_SCOPE_PREFIX = "dxkjailbreak:settingsScope:";

function readScopeSection(storage, namespace) {
  if (!storage) return {};
  try {
    var raw = storage.getItem(SETTINGS_SCOPE_PREFIX + namespace);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) { return {}; }
}

function writeScopeSection(storage, namespace, section) {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_SCOPE_PREFIX + namespace, JSON.stringify(section));
  } catch (e) { /* 配额/隐私模式：内存值继续服务本页 */ }
}

function createSettingsScopeService(win) {
  var storage;
  try { storage = win && win.localStorage; } catch (e) { storage = undefined; }
  var listeners = {};
  function notify(namespace) {
    var bucket = listeners[namespace];
    if (!bucket) return;
    for (var i = 0; i < bucket.length; i++) { try { bucket[i](); } catch (e) { /* ignore */ } }
  }
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("storage", function (event) {
      if (!event || !event.key || event.key.indexOf(SETTINGS_SCOPE_PREFIX) !== 0) return;
      notify(event.key.slice(SETTINGS_SCOPE_PREFIX.length));
    });
  }
  return {
    bind: function (spec) {
      var namespace = (spec && spec.namespace) || "";
      var decode = spec && spec.decode;
      if (!listeners[namespace]) listeners[namespace] = [];
      var bucket = listeners[namespace];
      return {
        getSnapshot: function () {
          var section = readScopeSection(storage, namespace);
          var value;
          if (typeof decode === "function") {
            try { value = decode(section); } catch (e) { value = undefined; }
          } else value = section;
          return { status: "ready", value: value, writable: true, mode: "memory" };
        },
        subscribe: function (listener) {
          bucket.push(listener);
          return function () {
            var at = bucket.indexOf(listener);
            if (at >= 0) bucket.splice(at, 1);
          };
        },
        set: function (field, value) {
          var section = readScopeSection(storage, namespace);
          section[field] = value;
          writeScopeSection(storage, namespace, section);
          notify(namespace);
          return Promise.resolve();
        },
      };
    },
  };
}

/** 注册 settingsScope；测试桩（ctx 无 provide）直接跳过，已有提供者则不抢。 */
function provideSettingsScope(ctx) {
  if (!ctx || typeof ctx.provide !== "function") return;
  var win;
  try { win = typeof window !== "undefined" ? window : undefined; } catch (e) { win = undefined; }
  try {
    ctx.provide("settingsScope", createSettingsScopeService(win));
  } catch (e2) { /* 别的插件先提供了：兄弟们绑它的实现 */ }
}

/** UI 全局样式（作用域 .dxkjailbreak-console；纯观感，零行为改动）。 */
function consoleStyles() {
  const css = `
    .dxkjailbreak-console {
      --dxk-accent:#6576e6;
      --dxk-shadow:0 6px 24px rgba(15,23,42,.09);
      --dxk-line:color-mix(in srgb,currentColor 17%,transparent);
      --dxk-surface:color-mix(in srgb,currentColor 4%,transparent);
      --dxk-tint:color-mix(in srgb,var(--dxk-accent) 14%,transparent);
      --dxk-focus:#768bf3;
      /* 状态色（深浅双轨：宿主深色时自动切换，不再刺眼） */
      --dxk-ok:#3aa675;
      --dxk-warn:#c9922e;
      --dxk-bad:#d05050;
      --dxk-drift:#d07850;
      --dxk-muted:#8a8a8a;
      --dxk-info:#6b7fd7;
      container-type:inline-size;
      font-family:Inter,system-ui,"Microsoft YaHei UI",sans-serif;color:inherit;min-width:0;width:100%;
      max-width:100%;overflow-wrap:anywhere
    }
    .dxkjailbreak-console :where(button,input,textarea,select) { box-sizing:border-box;max-width:100%;color:inherit }
    .dxkjailbreak-console :where(a,button,input,textarea,select,[tabindex]):focus-visible {
      outline:2px solid var(--dxk-focus);outline-offset:2px
    }
    .dxkjailbreak-console .dxk-header {
      display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
      padding:20px;margin:0 0 16px;border:1px solid var(--dxk-line);border-radius:18px;
      background:radial-gradient(ellipse at top left,var(--dxk-tint),transparent 68%),var(--dxk-surface);
      box-shadow:var(--dxk-shadow)
    }
    .dxkjailbreak-console .dxk-brand { display:flex;align-items:center;gap:14px;min-width:0 }
    .dxkjailbreak-console .dxk-brand-mark {
      display:block;flex:none;width:48px;height:48px;border-radius:13px;object-fit:cover;
      box-shadow:0 3px 12px rgba(72,92,194,.28)
    }
    .dxkjailbreak-console .dxk-header h2 { margin:0;font-size:22px;line-height:1.2;letter-spacing:-.03em }
    .dxkjailbreak-console .dxk-author { display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px;margin-top:5px;font-size:12px }
    .dxkjailbreak-console .dxk-author > span { opacity:.8 }
    .dxkjailbreak-console .dxk-author a { color:inherit;text-underline-offset:3px }
    .dxkjailbreak-console .dxk-header-actions { display:grid;grid-template-columns:auto auto;align-items:center;justify-content:start;gap:8px }
    .dxkjailbreak-console .dxk-star {
      display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;
      color:inherit;font-weight:650;text-decoration:none;border:1px solid var(--dxk-accent);background:var(--dxk-tint)
    }
    .dxkjailbreak-console .dxk-star:hover { background:color-mix(in srgb,var(--dxk-accent) 27%,transparent) }
    .dxkjailbreak-console .dxk-star-note { grid-column:1/-1;margin:0;font-size:12px;opacity:.82 }
    .dxkjailbreak-console .dxk-version {
      border:1px solid var(--dxk-line);background:var(--dxk-surface);
      border-radius:999px;padding:5px 10px;font:11px ui-monospace,Consolas,monospace
    }
    .dxkjailbreak-console .dxk-layout { display:grid;gap:14px;min-width:0 }
    .dxkjailbreak-console .dxk-nav-shell { min-width:0 }
    .dxkjailbreak-console .dxk-nav {
      display:flex;flex-wrap:wrap;gap:4px;padding:5px;margin:0 0 6px;
      border:1px solid var(--dxk-line);border-radius:12px;background:var(--dxk-surface)
    }
    .dxkjailbreak-console .dxk-nav button {
      min-height:36px;border-color:transparent!important;border-radius:8px!important
    }
    .dxkjailbreak-console .dxk-nav button:is([aria-selected=true],[aria-pressed=true]) {
      background:var(--dxk-tint);box-shadow:inset 0 -2px var(--dxk-accent);opacity:1
    }
    .dxkjailbreak-console .dxk-panel {
      padding:18px;border:1px solid var(--dxk-line);border-radius:16px;min-width:0
    }
    .dxkjailbreak-console .dxk-card {
      background:var(--dxk-surface);border-color:var(--dxk-line)!important;border-radius:12px!important
    }
    .dxkjailbreak-console .dxk-conversations { display:grid;gap:14px;min-width:0 }
    .dxkjailbreak-console .dxk-conversations h3 { margin:0;font-size:16px;letter-spacing:-.015em }
    .dxkjailbreak-console .dxk-session-toolbar {
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap
    }
    .dxkjailbreak-console .dxk-session-actions { display:flex;align-items:center;flex-wrap:wrap;gap:8px }
    .dxkjailbreak-console .dxk-session-filter {
      display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;
      border:1px solid var(--dxk-line);border-radius:12px;background:var(--dxk-surface)
    }
    .dxkjailbreak-console .dxk-session-filter[hidden] { display:none }
    .dxkjailbreak-console .dxk-session-filter input { flex:1 1 14rem;min-width:0;min-height:34px }
    .dxkjailbreak-console .dxk-session-summary { display:grid;grid-template-columns:repeat(auto-fit,minmax(min(136px,100%),1fr));gap:10px }
    .dxkjailbreak-console .dxk-session-list { overflow-x:auto;min-width:0 }
    .dxkjailbreak-console .dxk-session-list table { border-collapse:separate;border-spacing:0 }
    .dxkjailbreak-console .dxk-session-list :is(th,td) { box-sizing:border-box;padding:10px 6px }
    .dxkjailbreak-console .dxk-session-list th:first-child { width:37% }
    .dxkjailbreak-console .dxk-session-list th:nth-child(2) { width:26% }
    .dxkjailbreak-console .dxk-session-list th:last-child { width:20% }
    .dxkjailbreak-console .dxk-session-list button { --dxk-bad:light-dark(#a42a3e,#f18ca0) }
    .dxkjailbreak-console .dxk-session-time { display:block;font-variant-numeric:tabular-nums }
    .dxkjailbreak-console .dxk-session-time span + span { display:block;opacity:.8 }
    .dxkjailbreak-console .dxk-session-workspace { display:block;font-size:11px;opacity:.8 }
    .dxkjailbreak-console .dxk-session-note { margin:0;opacity:.8 }
    .dxkjailbreak-console .dxk-session-message {
      margin:0;padding:16px;border:1px solid var(--dxk-line);border-radius:12px;background:var(--dxk-surface)
    }
    .dxkjailbreak-console .dxk-checks {
      display:grid;grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr));gap:6px;margin:8px 0
    }
    .dxkjailbreak-console .dxk-check {
      display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 9px;
      border:1px solid var(--dxk-line);border-radius:8px;font-size:11px
    }
    .dxkjailbreak-console .dxk-check[data-status=verified] { border-color:var(--dxk-ok) }
    .dxkjailbreak-console .dxk-check[data-status=bad] { border-color:var(--dxk-bad) }
    .dxkjailbreak-console .dxk-check[data-status=pending] { border-color:var(--dxk-warn) }
    .dxkjailbreak-console .dxk-busy { margin:8px 2px;color:inherit;animation:dxk-pulse 1.1s ease-in-out infinite }
    .dxkjailbreak-console [role=alert] { overflow-wrap:anywhere }
    .dxkjailbreak-console button { transition:border-color .12s ease,background .12s ease }
    .dxkjailbreak-console button:not(:disabled):hover { border-color:var(--dxk-accent);background:var(--dxk-tint) }
    .dxkjailbreak-console button:disabled { opacity:.55;cursor:wait }
    .dxkjailbreak-console table tbody tr:hover { background:var(--dxk-surface) }
    .dxkjailbreak-console pre { scrollbar-width:thin }
    @media (prefers-color-scheme:dark) {
      .dxkjailbreak-console {
        --dxk-ok:#5bc492;
        --dxk-warn:#e0b25a;
        --dxk-bad:#f07a7a;
        --dxk-drift:#f0a07a;
        --dxk-muted:#9a9a9a;
        --dxk-info:#8a9cf0;
      }
    }
    .dxkjailbreak-console .dxk-badge-ok { color:var(--dxk-ok);border-color:var(--dxk-ok) }
    .dxkjailbreak-console .dxk-badge-warn { color:var(--dxk-warn);border-color:var(--dxk-warn) }
    .dxkjailbreak-console .dxk-badge-bad { color:var(--dxk-bad);border-color:var(--dxk-bad) }
    .dxkjailbreak-console .dxk-badge-drift { color:var(--dxk-drift);border-color:var(--dxk-drift) }
    .dxkjailbreak-console .dxk-badge-muted { color:var(--dxk-muted);border-color:var(--dxk-muted) }
    .dxkjailbreak-console .dxk-badge-info { color:var(--dxk-info);border-color:var(--dxk-info) }
    .dxkjailbreak-console button:not(:disabled):active { transform:translateY(1px) }
    @keyframes dxk-pulse { 0%,100% { opacity:.55 } 50% { opacity:1 } }
    @container (min-width:800px) {
      .dxkjailbreak-console .dxk-layout { grid-template-columns:144px minmax(0,1fr);align-items:start }
      .dxkjailbreak-console .dxk-nav { flex-direction:column }
      .dxkjailbreak-console .dxk-nav button { text-align:start }
      .dxkjailbreak-console .dxk-nav button:is([aria-selected=true],[aria-pressed=true]) { box-shadow:inset 2px 0 var(--dxk-accent) }
    }
    @container (max-width:520px) {
      .dxkjailbreak-console .dxk-header,.dxkjailbreak-console .dxk-panel { padding:13px }
      .dxkjailbreak-console .dxk-brand-mark { width:42px;height:42px }
      .dxkjailbreak-console .dxk-header h2 { font-size:19px }
      .dxkjailbreak-console .dxk-nav button { min-height:36px }
    }
    @media(prefers-reduced-motion:reduce) {
      .dxkjailbreak-console * { animation:none!important;transition:none!important }
    }
  `;
  return el("style", { text: css });
}

function renderReleaseCheck(api, buttonStyle = C.btn) {
  const status = el("span", { role: "status", "aria-live": "polite", style: "font-size:12px;overflow-wrap:anywhere" });
  const button = el("button", {
    type: "button",
    style: buttonStyle,
    text: "检查更新",
    onclick: async () => {
      button.textContent = "正在检查…";
      status.textContent = "";
      try {
        const result = await callApi(api, "checkPluginUpdate", []);
        if (result?.ok !== true) {
          status.textContent = "检查失败：" + (result?.error || "未收到有效的版本信息。");
          return;
        }
        if (result.state === "unpublished") {
          status.textContent = "GitHub 暂无正式发行版本。";
          return;
        }
        if (result.state === "current") {
          status.textContent = "已是最新版（" + result.latestTag + "）。";
          return;
        }
        if (result.state === "ahead") {
          status.textContent = "本地版本高于 GitHub 正式版（" + result.latestTag + "）。";
          return;
        }
        if (result.state === "available") {
          status.textContent = "发现新版本 " + result.latestTag + "。 ";
          status.appendChild(el("a", {
            href: result.releaseUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            text: "查看发行说明",
          }));
          status.appendChild(document.createTextNode(" "));
          status.appendChild(el("button", {
            type: "button",
            style: C.btnDanger,
            text: "安装更新",
            onclick: async (event) => {
              const btn = event.currentTarget;
              btn.disabled = true;
              btn.textContent = "正在安装…";
              status.textContent = "";
              try {
                const response = await fetch("/dxkjailbreak/update", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ op: "apply", ref: result.latestTag, channel: "stable" }),
                  signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(300000) : undefined,
                });
                const payload = await response.json().catch(() => null);
                if (!response.ok || !payload || payload.ok === false || payload.applied === false) {
                  status.textContent = "安装未完成：" + ((payload && (payload.error || payload.skipped)) || ("HTTP " + response.status)) + "。可点「查看发行说明」手动下载。";
                  return;
                }
                const version = (payload.results && payload.results.find((item) => item.applied) || {}).version || (payload.lanes && payload.lanes.stable && payload.lanes.stable.version) || String(result.latestTag || "").replace(/^v/, "");
                status.textContent = "已安装 v" + version + "，重启 DSH 后生效。";
              } catch (error) {
                status.textContent = "安装请求失败：" + String((error && error.message) || error);
              } finally {
                btn.disabled = false;
                btn.textContent = "安装更新";
              }
            },
          }));
          return;
        }
        status.textContent = "未收到有效的版本信息。";
      } finally {
        button.textContent = "检查更新";
      }
    },
  });
  return el("div", {
    style: "grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0",
  }, [button, status]);
}

function renderConsole(api) {
  // 不在这里拦「宿主有没有注入服务对象」：callApi 有同源 HTTP 回退，
  // 挂载点传的是 {}（宿主并不注入控制台服务）。早拦会让整个设置页只剩一行错误、
  // 一个请求都不发（DS 复测：HTTP 请求数 0）。
  const panelId = "dxk-panel-" + ++nextPanelId;
  const root = el("div", { className: "dxkjailbreak-console", style: "font-size:12px;line-height:1.6" });
  const errBar = el("div", { role: "alert", hidden: true, style: "margin:6px 0;padding:6px 10px;border-radius:6px;background:rgba(208,80,80,.12);border:1px solid rgba(208,80,80,.5);color:#d05050" });
  const busy = el("div", { className: "dxk-busy", role: "status", style: "display:none;margin:4px 0;font-size:11px;opacity:.7" , text: "处理中…" });

  const showError = (msg) => {
    errBar.textContent = msg || "";
    errBar.hidden = !msg;
  };
  let pending = 0;
  let paneVersion = 0;
  const withBusy = async (fn) => {
    const version = paneVersion;
    pending++;
    busy.style.display = "block";
    try { return await fn(); }
    catch (error) {
      if (version === paneVersion) showError("操作失败：" + (error?.message || String(error)));
    } finally {
      if (--pending === 0) busy.style.display = "none";
    }
  };
  const guard = (msg, fn) => async () => {
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(msg)) return;
    await withBusy(fn);
  };

  let version = "v" + FALLBACK_VERSION;
  const versionLine = el("span", { className: "dxk-version", text: version, "aria-label": "插件版本" });
  const header = el("header", { className: "dxk-header" }, [
    el("div", { className: "dxk-brand" }, [
      el("img", { className: "dxk-brand-mark", src: "/dxkjailbreak/brand.png", alt: "", width: 48, height: 48 }),
      el("div", {}, [
        el("h2", { text: "dxkjailbreak" }),
        el("div", { className: "dxk-author" }, [
          el("span", { text: "by dxk" }),
          el("span", { "aria-hidden": "true", text: "·" }),
          el("a", {
            href: "https://github.com/pugyy/dxkjailbreak",
            target: "_blank",
            rel: "noopener noreferrer",
            text: "github.com/pugyy/dxkjailbreak",
          }),
        ]),
      ]),
    ]),
    el("div", { className: "dxk-header-actions" }, [
      versionLine,
      el("a", {
        className: "dxk-star",
        href: "https://github.com/pugyy/dxkjailbreak",
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": "在 GitHub 上为项目点 Star",
      }, [el("span", { "aria-hidden": "true", text: "★" }), "给项目点 Star"]),
      el("p", { className: "dxk-star-note", text: "您的 Star 是我继续维护的动力。" }),
      renderReleaseCheck(api),
    ]),
  ]);

  // 状态缓存（跨 tab 复用，避免重复请求）
  const cache = { status: null, patches: null, audit: null, selfcheck: null };

  // 进行中的 status 请求：首页初始渲染和「状态」页签会几乎同时调 loadStatus，
  // 不去重就会并发发两次同样的请求（DS 复测指出）。这里复用同一个 Promise。
  let statusInflight = null;
  const loadStatus = async (force) => {
    if (cache.status && !force) return cache.status;
    if (statusInflight) return statusInflight;
    statusInflight = (async () => {
      const data = await callApi(api, "status", []);
      const r = data && typeof data === "object" && data.ok !== false && !data.error
        ? data : { ok: false, error: data?.error || "宿主未返回有效状态。" };
      if (r.ok !== false) cache.status = r;
      if (r && r.version) { version = "v" + r.version; versionLine.textContent = version; }
      return r;
    })();
    try { return await statusInflight; } finally { statusInflight = null; }
  };

  // ── 区 1：开关 ──
  const paneToggle = () => {
    const info = el("div", { style: C.muted + ";margin-bottom:8px" });
    const render = async (force) => {
      const s = await loadStatus(force);
      const sc = s && s.selfcheck;
      const stateText = sc ? (sc.ok ? "已打甲（运行中）" : "未完全打甲") : "未知";
      info.textContent = "当前：" + stateText + (sc && sc.state ? "（selfcheck state=" + sc.state + "）" : "");
    };
    const on = el("button", { text: "开启（打甲）", style: C.btn, onclick: () => withBusy(async () => {
      const r = await callApi(api, "toggle", [true]);
      if (!r || r.ok === false) showError("打甲失败：" + ((r && r.error) || "未知错误"));
      else showError("");
      await render(true);
    }) });
    const off = el("button", { text: "关闭（还原宿主）", style: C.btnDanger, onclick: guard(
      "确定关闭？会 revert 全部宿主补丁并撤销注入（B 全停），插件本身仍保留以便再开启。",
      async () => {
        const r = await callApi(api, "toggle", [false]);
        if (!r || r.ok === false) showError("还原失败：" + ((r && r.error) || "未知错误"));
        else showError("");
        await render(true);
      }) });
    render(false);
    return el("div", {}, [
      el("div", { style: C.row }, [on, off]),
      info,
      el("p", { text: "开关为 B 全停语义：关闭 = revert 宿主补丁 + 撤注入；开启 = 重新 apply。", style: C.muted }),
    ]);
  };

  // ── 区 2：状态 ──
  const paneStatus = () => {
    const cards = el("div", { style: C.row });
    const strip = el("div", {});
    const hints = el("div", {});
    const auto = el("input", { type: "checkbox", style: "vertical-align:middle" });
    let timer = null;
    const render = async (force) => {
      const s = await loadStatus(force);
      cards.replaceChildren();
      strip.replaceChildren();
      hints.replaceChildren();
      if (!s || s.error) { cards.appendChild(card("状态", "读取失败", s && s.error)); return; }
      const sc = s.selfcheck && typeof s.selfcheck === "object" ? s.selfcheck : {};
      strip.appendChild(stepStrip(sc));
      const p = sc.patch || {};
      cards.appendChild(card("版本", s.version || "?", "插件 " + (s.plugin || "")));
      const check = { ok: "已核验", broken: "异常", pending: "待处理", inferred: "部分确认", unknown: "未确认" };
      cards.appendChild(card("检测状态", check[sc.state] || "未确认", ""));
      const applied = Number.isInteger(p.applied) ? p.applied : null;
      const total = Number.isInteger(p.total) ? p.total : null;
      const pendingCount = sc.summary?.pending?.patches;
      cards.appendChild(card("补丁统计", applied !== null && total !== null ? applied + " / " + total : "—",
        Number.isInteger(pendingCount) ? "待处理 " + pendingCount : "等待检测数据"));
      cards.appendChild(card("宿主", sc.host_version || "?", sc.level || ""));
      cards.appendChild(card("插件根", shortPath(s.ai_base), "DSH_HOME " + shortPath(s.dsh_home)));
      if (Array.isArray(sc.hints) && sc.hints.length) {
        hints.appendChild(el("div", { text: "需要注意：", style: "margin-top:8px;font-weight:600" }));
        hints.appendChild(el("ul", { style: "margin:4px 0 0 18px;padding:0" },
          sc.hints.slice(0, 12).map((h) => el("li", { text: (h.title || "") + " — " + (h.action || ""), style: "margin-bottom:3px" }))));
      }
    };
    const refreshBtn = el("button", { text: "刷新", style: C.btn, onclick: () => withBusy(() => render(true)) });
    auto.addEventListener("change", () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (auto.checked) timer = setInterval(() => { void withBusy(() => render(true)); }, 10000);
    });
    void withBusy(() => render(false));
    const pane = el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [refreshBtn, el("label", { style: "display:flex;gap:4px;align-items:center;font-size:11px;opacity:.75" }, [auto, "每 10 秒自动刷新"])]),
      cards, strip, hints,
    ]);
    // 卸载钩子：切页签/关面板时清掉自动刷新定时器，避免反复切换累积
    pane.__dxkDispose = () => { if (timer) { clearInterval(timer); timer = null; } };
    return pane;
  };

  // ── 区 2.5：模式 ──
  const panePreset = () => {
    const cards = el("div", { style: C.row });
    const body = el("div", {});
    const note = el("div", { style: C.muted + ";margin-top:6px;font-size:11px" });
    const render = () => withBusy(async () => {
      const r = await callApi(api, "preset", ["list"]);
      cards.replaceChildren();
      body.replaceChildren();
      note.textContent = "";
      if (!r || r.ok === false) {
        cards.appendChild(card("模式", "读取失败", (r && r.error) || ""));
        return;
      }
      // 防御：后端可能返回 {ok:true} 但缺 presets（服务异常/旧版本/字段改名）。
      // 裸访问 r.presets.find 会抛 TypeError 把整个页签打崩。
      const presets = Array.isArray(r.presets) ? r.presets.filter(item => item && typeof item === "object") : [];
      const cur = presets.find((p) => p.isDefault) || null;
      cards.appendChild(card("当前默认模式", cur ? (cur.title || cur.id) : "未知", cur ? cur.id : ""));
      cards.appendChild(card("单卡是否就位", r.singleCardPresent ? "已安装" : "未安装", r.singleCard));
      cards.appendChild(card("可用模式数", String(presets.length), "宿主自带 + 已装预设"));
      if (!r.singleCardPresent) {
        note.textContent = "未检测到 dxkjailbreak 预设：请先在「安装」流程里装好预设，再回到这里设默认。";
      } else if (cur && cur.isSingleCard) {
        note.textContent = "已经是单卡：新会话默认就用 dxkjailbreak，全域能力（渗透/代审/逆向/攻防/免杀/应急/云/CTF/测绘）全在。";
      } else {
        note.textContent = "当前默认不是单卡。点下面「设为默认（单卡）」即可；若按钮报不支持，去宿主模式下拉手动选一次 dxkjailbreak。";
      }
      body.replaceChildren(table(
        ["预设", "ID", "状态", ""],
        presets,
        (p) => [
          el("td", { text: p.title || p.id, style: C.td + (p.isSingleCard ? ";font-weight:700" : "") }),
          el("td", { text: p.id, style: C.td + ";opacity:.7" }),
          el("td", { style: C.td }, [
            p.isDefault ? badge("默认", "#3aa675") : el("span", { text: "-", style: C.muted }),
            p.isSingleCard ? document.createTextNode(" ") : null,
            p.isSingleCard ? badge("单卡", "#6b7fd7") : null,
            p.failed ? document.createTextNode(" ") : null,
            p.failed ? badge("激活失败", "#d05050") : null,
          ]),
          el("td", { style: C.td }, [
            p.isDefault ? null : el("button", {
              text: "设为默认",
              style: C.btn,
              onclick: () => withBusy(async () => {
                const res = await callApi(api, "preset", ["set", { id: p.id }]);
                if (!res || res.ok === false) {
                  showError("设置默认失败：" + ((res && (res.hint || res.error)) || "未知"));
                } else {
                  showError("");
                }
                await render();
              }),
            }),
          ]),
        ]
      ));
    });
    render();
    return el("div", {}, [
      el("div", { style: C.row }, [
        el("button", { text: "刷新", style: C.btn, onclick: render }),
        el("button", {
          text: "收敛模式（归档其它预设）",
          style: C.btnDanger,
          onclick: () => withBusy(async () => {
            if (typeof window !== "undefined" && typeof window.confirm === "function"
              && !window.confirm("把 .agent-presets 下除单卡外的预设目录整体移到 .agent-presets-archive/（可逆），下拉只剩「李云龙攻打平安县城」+ 宿主出厂预设。继续？")) return;
            const r = await callApi(api, "preset", ["converge", { keep: "redteam" }]);
            if (!r || r.ok === false) showError("收敛失败：" + ((r && r.error) || "未知"));
            else {
              showError("");
              const moved = (r.result && r.result.moved) || [];
              note.textContent = "已归档 " + moved.length + " 个预设：" + (moved.join("、") || "无") + "。重启 dsh web 后下拉生效。";
            }
            await render();
          }),
        }),
      ]),
      cards, body, note,
      el("p", { text: "本产品理论上只需「单卡（dxkjailbreak）」：它把十种专业模式（渗透/代审/逆向/攻防/免杀/应急/云安全/CTF/测绘/总控）合到一张卡里，按任务自动切换打法。宿主自带的 standard 等出厂预设不是本产品的模式。", style: C.muted }),
    ]);
  };

  // ══════════════ 作战沙盘（后端 store-core.dispatch 70 个 op）══════════════
  const rt = (op, payload) => callApi(api, "redteam", [op, payload || {}]);

  /** 通用：把任意 op 的结果渲染成表格/键值/JSON（作战沙盘各页复用）。 */
  const rtView = (box, r, cols) => {
    box.replaceChildren();
    if (!r || r.ok === false) {
      box.appendChild(el("div", { text: "失败：" + ((r && (r.error || r.message)) || "未知"), style: "color:#d05050" }));
      return;
    }
    const rows = Array.isArray(r) ? r : (r.items || r.assets || r.vulns || r.tunnels || r.sessions || r.webshells || r.tests || r.rows || null);
    if (Array.isArray(rows)) {
      if (!rows.length) { box.appendChild(el("div", { text: "（暂无数据）", style: C.muted })); return; }
      box.appendChild(table(cols.map((c) => c[0]), rows, (row) => cols.map((c) => {
        const v = typeof c[1] === "function" ? c[1](row) : row[c[1]];
        return el("td", { text: v === undefined || v === null ? "-" : String(v).slice(0, 120), style: C.td });
      })));
      return;
    }
    box.appendChild(el("pre", { text: JSON.stringify(r, null, 2).slice(0, 4000), style: C.pre }));
  };

  const paneTargets = () => {
    const cards = el("div", { style: C.row });
    const body = el("div", {});
    const nameInput = el("input", { placeholder: "靶标单位名称（例：示例科技有限公司）", style: C.input + ";flex:1 1 260px" });
    const render = () => withBusy(async () => {
      const b = await rt("bootstrap");
      cards.replaceChildren();
      if (!b || b.ok === false) { body.replaceChildren(el("div", { text: "失败：" + ((b && b.error) || ""), style: "color:#d05050" })); return; }
      const list = b.engagements || [];
      const cur = list.find((x) => x.id === b.current) || null;
      cards.appendChild(card("靶标数", list.length, "数据根 " + shortPath(b.root)));
      cards.appendChild(card("当前靶标", cur ? (cur.name || cur.id) : "未选择", cur ? cur.id : ""));
      body.replaceChildren(
        table(["靶标", "ID", "状态", ""], list, (e) => [
          el("td", { text: e.name || e.id, style: C.td }),
          el("td", { text: e.id, style: C.td + ";opacity:.7" }),
          el("td", { style: C.td }, [String(e.id) === String(b.current) ? badge("当前", "#3aa675") : el("span", { text: "-", style: C.muted })]),
          el("td", { style: C.td }, [
            el("button", { text: "切换", style: C.btn, onclick: () => withBusy(async () => { await rt("activateEngagement", { engagement: e.id }); await render(); }) }),
          ]),
        ])
      );
    });
    render();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [nameInput,
        el("button", { text: "创建靶标并开始", style: C.btn, onclick: () => withBusy(async () => {
          const name = (nameInput.value || "").trim();
          if (!name) { showError("先填靶标单位名称"); return; }
          const r = await rt("openEngagement", { name });
          if (!r || r.ok === false) showError("创建失败：" + ((r && r.error) || ""));
          else { showError(""); nameInput.value = ""; }
          await render();
        }) }),
        el("button", { text: "刷新", style: C.btn, onclick: render }),
      ]),
      cards, el("div", { style: "margin-top:6px" }, [body]),
      el("p", { text: "资产测绘页签：创建/切换靶标。资产、漏洞、隧道等数据都按靶标分账。", style: C.muted }),
    ]);
  };

  const paneEnv = () => {
    const body = el("div", {});
    const render = () => withBusy(async () => {
      const r = await rt("platformConfigGet");
      body.replaceChildren();
      if (!r || r.ok === false) { body.appendChild(el("div", { text: "失败：" + ((r && r.error) || ""), style: "color:#d05050" })); return; }
      const cfg = r.config || {};
      const toolEntries = (r.tools && Array.isArray(r.tools.items)) ? r.tools.items.map((t, i) => [t.name || t.id || t.tool || ("#" + (i + 1)), t]) : Object.entries(r.tools || cfg.tools || {});
      const found = toolEntries.filter(([k, t]) => t && (t.path || t.found)).length;
      body.appendChild(el("div", { style: C.row }, [
        card("平台", (r.runtime && r.runtime.effective) || r.platform || cfg.platform || "auto", "工具箱 " + shortPath(r.toolkitDir || cfg.toolkitDir || "")),
        card("工具", found + "/" + toolEntries.length, (r.tools && typeof r.tools.found === "number" ? "已识别 " + r.tools.found : "已识别")),
        card("工具箱", (cfg.toolkitDir || "默认").toString().slice(-28), ""),
      ]));
      // 可编辑项
      const toolkit = el("input", { value: cfg.toolkitDir || "", placeholder: "工具箱目录", style: C.input + ";flex:1 1 260px" });
      const fofa = el("input", { value: cfg.fofaKey || "", placeholder: "FOFA_KEY（留空不覆盖）", style: C.input + ";flex:1 1 200px" });
      const vps = el("input", { value: cfg.vpsHost || "", placeholder: "VPS user@host（留空不覆盖）", style: C.input + ";flex:1 1 200px" });
      body.appendChild(el("div", { style: C.row + ";align-items:center;margin-top:8px" }, [toolkit, fofa, vps,
        el("button", { text: "保存", style: C.btn, onclick: () => withBusy(async () => {
          const res = await rt("platformConfigSave", { config: { toolkitDir: toolkit.value.trim(), fofaKey: fofa.value.trim(), vpsHost: vps.value.trim() } });
          if (!res || res.ok === false) showError("保存失败：" + ((res && res.error) || ""));
          else { showError(""); await render(); }
        }) }),
        el("button", { text: "自动分配工具", style: C.btn, onclick: () => withBusy(async () => {
          const res = await rt("platformAssignToolkit", { dir: toolkit.value.trim() });
          if (!res || res.ok === false) showError("自动分配失败：" + ((res && res.error) || ""));
          else { showError(""); await render(); }
        }) }),
      ]));
      body.appendChild(el("div", { style: "margin-top:8px" }, [
        table(["工具", "状态", "路径"], toolEntries.map(([k, v]) => ({ name: k, v })), (row) => [
          el("td", { text: row.name, style: C.td }),
          el("td", { style: C.td }, [badge(row.v && (row.v.path || row.v.found) ? "已找到" : "未找到", row.v && (row.v.path || row.v.found) ? "#3aa675" : "#8a8a8a")]),
          el("td", { text: String((row.v && row.v.path) || "-").slice(0, 90), style: C.td + ";opacity:.75" }),
        ]),
      ]));
    });
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), body,
      el("p", { text: "对应原「环境适配」：工具路径、FOFA_KEY、VPS。留空字段不覆盖已有配置。", style: C.muted })]);
  };

  const paneAgents = () => {
    const body = el("div", {});
    const render = () => withBusy(async () => {
      const r = await rt("prompts");
      body.replaceChildren();
      if (!r || r.ok === false) { body.appendChild(el("div", { text: "失败：" + ((r && r.error) || ""), style: "color:#d05050" })); return; }
      const items = r.roles || r.items || r.prompts || (Array.isArray(r) ? r : []);
      body.appendChild(table(["角色", "标题", "字数", ""], items, (p) => [
        el("td", { text: p.role || p.id || "-", style: C.td }),
        el("td", { text: p.title || "-", style: C.td }),
        el("td", { text: String((p.text || p.content || "").length), style: C.td + ";opacity:.7" }),
        el("td", { style: C.td }, [p.text || p.content ? el("span", { text: "（编辑走高级 op：savePrompt）", style: C.muted }) : el("span", { text: "-", style: C.muted })]),
      ]));
      const sc = await rt("sessions");
      body.appendChild(el("div", { style: "margin-top:10px;font-weight:600", text: "作战会话" }));
      body.appendChild(el("pre", { text: JSON.stringify((sc && (sc.totals || sc)) || {}, null, 2).slice(0, 2000), style: C.pre }));
    });
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), body,
      el("p", { text: "对应原「智能体」：六角色提示词 + 作战会话。并发上限、派活在主会话里用 redteam_agent_slot 控制。", style: C.muted })]);
  };

  const paneTunnels = () => {
    const box = el("div", {});
    const render = () => withBusy(async () => rtView(box, await rt("tunnels"), [
      ["隧道", (x) => x.name || x.id || "-"], ["类型", (x) => x.type || "-"],
      ["监听", (x) => x.listen || x.address || "-"], ["可达网段", (x) => (Array.isArray(x.reach) ? x.reach.join(",") : x.reach) || "-"],
    ]));
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), box,
      el("p", { text: "对应原「会话隧道」：suo5 / frp / chisel 等隧道登记。", style: C.muted })]);
  };

  const paneVulns = () => {
    const box = el("div", {});
    const stat = el("div", { style: C.row });
    const render = () => withBusy(async () => {
      const s = await rt("vulnStats");
      stat.replaceChildren();
      if (s && s.ok !== false) {
        const d = s.stats || s;
        stat.appendChild(card("漏洞总数", d.total ?? "-", ""));
        stat.appendChild(card("已验证", (d.byStatus && (d.byStatus.verified ?? d.byStatus.confirmed)) ?? "-", "byStatus 口径"));
        stat.appendChild(card("按等级", (d.bySeverity && Object.keys(d.bySeverity).length) ?? "-", ""));
      }
      rtView(box, await rt("vulns"), [
        ["漏洞", (x) => x.title || x.name || "-"], ["等级", (x) => x.severity || "-"],
        ["资产", (x) => x.asset || x.host || "-"], ["状态", (x) => x.status || "-"],
      ]);
    });
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), stat, box,
      el("p", { text: "对应原「漏洞成果」：按靶标分账的漏洞清单。", style: C.muted })]);
  };

  const paneChain = () => {
    const box = el("div", {});
    const render = () => withBusy(async () => rtView(box, await rt("chain"), [
      ["步骤", (x) => x.step || x.seq || "-"], ["动作", (x) => x.action || x.title || "-"],
      ["资产", (x) => x.asset || x.target || "-"], ["时间", (x) => x.at || x.time || "-"],
    ]));
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), box,
      el("p", { text: "对应原「攻击链」：入口→立足→提权→横向→目标的节点时序。", style: C.muted })]);
  };

  const paneScore = () => {
    const box = el("div", {});
    const cards = el("div", { style: C.row });
    const render = () => withBusy(async () => {
      const s = await rt("scoreChain");
      cards.replaceChildren();
      if (s && s.ok !== false) {
        const d = s.result || s;
        cards.appendChild(card("得分", ((d.summary && d.summary.points) ?? "-") + " / " + ((d.summary && d.summary.totalPoints) ?? "-"), ""));
        cards.appendChild(card("得分项", Array.isArray(d.items) ? d.items.length : (d.count ?? "-"), ""));
      }
      rtView(box, await rt("scores"), [
        ["得分项", (x) => x.title || x.name || "-"], ["分值", (x) => x.score ?? x.value ?? "-"],
        ["状态", (x) => x.status || "-"], ["资产", (x) => x.asset || "-"],
      ]);
    });
    render();
    return el("div", {}, [el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]), cards, box,
      el("p", { text: "对应原「得分目标」：得分项与当前得分。改分项走高级 op：saveScorePoint / deleteScorePoint。", style: C.muted })]);
  };

  const paneReport = () => {
    const box = el("div", {});
    const render = () => withBusy(async () => {
      const r = await rt("scoreReport");
      box.replaceChildren(el("pre", { text: JSON.stringify(r, null, 2).slice(0, 6000), style: C.pre }));
      if (!r || r.ok === false) showError("报告读取失败：" + ((r && r.error) || ""));
    });
    const markdown = () => withBusy(async () => {
      const r = await rt("report");
      box.replaceChildren(el("pre", { text: typeof r === "string" ? r : JSON.stringify(r, null, 2).slice(0, 8000), style: C.pre }));
    });
    render();
    return el("div", {}, [el("div", { style: C.row }, [
      el("button", { text: "得分报告", style: C.btn, onclick: render }),
      el("button", { text: "完整报告", style: C.btn, onclick: markdown }),
    ]), box, el("p", { text: "对应原「报告」：按靶标生成。", style: C.muted })]);
  };

  const paneOps = () => {
    const cards = el("div", { style: C.row });
    const body = el("div", {});
    const status = el("div", { style: C.muted + ";margin-top:4px" });
    const render = () => withBusy(async () => {
      const [b, vs] = await Promise.all([rt("bootstrap"), rt("vulnStats")]);
      cards.replaceChildren();
      body.replaceChildren();
      if (!b || b.ok === false) {
        body.appendChild(el("div", { text: "读取失败：" + ((b && b.error) || ""), style: "color:#d05050" }));
        return;
      }
      const list = b.engagements || [];
      const cur = list.find((x) => x.id === b.current) || null;
      const s = (vs && vs.stats) || {};
      cards.appendChild(card("靶标", list.length, cur ? (cur.name || cur.id) : "未选择"));
      cards.appendChild(card("发现", s.total != null ? s.total : "—", "含待复核"));
      cards.appendChild(card("已验证", (s.byStatus && (s.byStatus.verified ?? s.byStatus.confirmed)) ?? "—", "可复现"));
      cards.appendChild(card("覆盖", s.targetGroups != null ? s.targetGroups : "—", "按目标聚合组数"));
      // 最近发现（最多 8 条）
      const v = await rt("vulns", { limit: 8 });
      const rows = (v && (v.items || v.vulns)) || [];
      if (rows.length) {
        body.appendChild(table(["标题", "等级", "状态", "类型"], rows, (x) => [
          el("td", { text: String(x.title || "").slice(0, 40), style: C.td }),
          el("td", { text: x.severity || "—", style: C.td }),
          el("td", { text: x.status || "—", style: C.td }),
          el("td", { text: String(x.type || "").slice(0, 18), style: C.td }),
        ]));
      } else {
        body.appendChild(el("p", { text: "当前靶标暂无发现记录。", style: C.muted }));
      }
      status.textContent = "数据根：" + shortPath(b.root || "");
    });
    render();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [
        el("button", { text: "刷新态势", style: C.btn, onclick: render }),
        el("button", { text: "校验链路", style: C.btn, onclick: () => withBusy(async () => {
          const r = await rt("chain");
          status.textContent = r && r.ok ? "链路节点 " + ((r.items || []).length) + " 个" : "读取失败：" + ((r && r.error) || "");
        }) }),
        el("button", { text: "战功评分", style: C.btn, onclick: () => withBusy(async () => {
          const r = await rt("scoreChain");
          status.textContent = r && r.ok ? "总分 " + (r && r.summary && r.summary.points != null ? (r.summary.points + " / " + r.summary.totalPoints) : "—") : "读取失败：" + ((r && r.error) || "");
        }) }),
      ]),
      cards, el("div", { style: "margin-top:6px" }, [body]), status,
      el("p", { text: "参谋台：汇总当前靶标的发现、覆盖与评分，快捷入口指向上面的各页签。", style: C.muted }),
    ]);
  };

  const panePromptFile = () => {
    const meta = el("div", { style: C.row });
    // 工作区路径：显式传给后端（不再依赖全局状态猜）。留空 = 用宿主会话工作区。
    const area = el("textarea", {
      style: "width:100%;min-height:320px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;padding:8px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:rgba(0,0,0,.18);color:inherit",
      onkeydown: (ev) => { if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) { ev.preventDefault(); savePrompt(); } },
      oninput: () => { try { status.textContent = "未保存（Ctrl+S 或点「保存」）"; } catch { /* ignore */ } },
    });
    const status = el("div", { style: C.muted + ";margin-top:4px" });
    let loadSeq = 0;
    const load = () => withBusy(async () => {
      const seq = ++loadSeq;
      const r = await callApi(api, "promptFile", ["read"]);
      if (seq !== loadSeq) return; // 旧请求丢弃
      meta.replaceChildren();
      if (!r || r.ok === false) { showError("读取失败：" + ((r && r.error) || "")); return; }
      area.value = r.text || "";
      meta.appendChild(card("字符数", r.chars, shortPath(r.path)));
      meta.appendChild(card("是否出厂默认", r.isDefault ? "是" : "否（已改过）", ""));
      status.textContent = "注入以该文件为准；保存会覆盖并留备份。";
    });
    const savePrompt = () => withBusy(async () => {
      const r = await callApi(api, "promptFile", ["save", area.value]);
      status.textContent = r && r.ok ? "已保存（" + r.chars + " 字）" : "保存失败：" + ((r && r.error) || "");
      if (r && r.ok) showError("");
    });
    load();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [
        el("button", { text: "刷新", style: C.btn, onclick: load }),
        el("button", { text: "保存", style: C.btn, onclick: savePrompt }),
        el("button", { text: "恢复默认", style: C.btnDanger, onclick: () => withBusy(async () => {
          if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("用插件内置出厂提示词覆盖当前文件？会先备份。")) return;
          const r = await callApi(api, "promptFile", ["reset"]);
          status.textContent = r && r.ok ? "已恢复默认（" + r.chars + " 字）" : "恢复失败：" + ((r && r.error) || "");
          if (r && r.ok) load();
        }) }),
      ]),
      meta, area, status,
      el("p", { text: "对应原「提示词」面板：编辑的就是注入正文。提示词框非空时本地 AGENTS.md 只作兜底。", style: C.muted }),
    ]);
  };

  // ── Hooks 拦截开关 ──
  const paneHooks = () => {
    const info = el("div", { style: C.muted + ";margin:6px 0" });
    const btn = el("button", { style: C.btn });
    const render = () => withBusy(async () => {
      const r = await callApi(api, "hooks", ["get"]);
      const on = !!(r && r.hooksDenyBypass);
      info.textContent = "当前：" + (on ? "放行 hooks 的 deny / ask（补丁 30/31/64/65 生效）" : "按官方逻辑放行用户 hook 的 deny");
      btn.textContent = on ? "关闭（恢复官方 hooks 行为）" : "开启（放行 hooks deny / ask）";
      btn.onclick = () => withBusy(async () => {
        const res = await callApi(api, "hooks", ["set", { hooksDenyBypass: !on }]);
        if (!res || res.ok === false) showError("设置失败：" + ((res && res.error) || ""));
        else { showError(""); await render(); }
      });
    });
    render();

    // ── 来源白名单（反代场景）：命中即放行，不看转发头 ──
    const wlInfo = el("div", { style: C.muted + ";margin:10px 0 4px" });
    const wlList = el("div", { style: "margin:4px 0" });
    const wlInput = el("input", {
      type: "text",
      placeholder: "https://dsh.example.com（反代对外域名）",
      style: C.input + ";flex:1 1 300px;min-width:0",
    });
    const loadWl = () => withBusy(async () => {
      const r = await callApi(api, "allowOrigin", ["list"]);
      wlList.replaceChildren();
      if (!r || r.ok === false) { wlInfo.textContent = "读取失败：" + ((r && r.error) || ""); return; }
      const list = r.origins || [];
      wlInfo.textContent = list.length
        ? "白名单 " + list.length + " 条（命中即放行，不看转发头）"
        : "白名单为空：控制台只接受同源请求；反代部署时在这里加上对外域名。";
      for (const o of list) {
        wlList.appendChild(el("div", { style: "display:flex;gap:8px;align-items:center;margin:2px 0" }, [
          el("code", { text: o, style: "font-size:12px" }),
          el("button", { text: "删除", style: C.btn, onclick: () => withBusy(async () => {
            const d = await callApi(api, "allowOrigin", ["remove", { origin: o }]);
            if (!d || d.ok === false) showError("删除失败：" + ((d && d.error) || ""));
            else showError("");
            await loadWl();
          }) }),
        ]));
      }
      if (r.file) wlInfo.title = r.file;
    });
    loadWl();
    const allowlistBlock = el("div", { style: "margin-top:14px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2)" }, [
      el("div", { style: C.sect, text: "来源白名单（反代）" }),
      wlInfo,
      el("div", { style: C.row + ";align-items:center" }, [wlInput,
        el("button", { text: "添加", style: C.btn, onclick: () => withBusy(async () => {
          const v = (wlInput.value || "").trim();
          if (!v) { showError("先填一个 Origin，如 https://dsh.example.com"); return; }
          const a = await callApi(api, "allowOrigin", ["add", { origin: v }]);
          if (!a || a.ok === false) showError("添加失败：" + ((a && a.error) || ""));
          else { showError(""); wlInput.value = ""; }
          await loadWl();
        }) }),
      ]),
      wlList,
      el("p", { text: "反代把 https 终结、后端走 http 时，协议比对会误杀——在这里写下对外域名即可放行。配置即信任，不看 x-forwarded-* 任何转发头。", style: C.muted }),
    ]);

    return el("div", {}, [btn, info,
      el("p", { text: "关掉后，用户自己的 PreToolUse / UserPromptSubmit / Stop hook 的 deny 会按官方逻辑生效；官方 ask 分支本身是空操作。改完点「应用」并重启才写进宿主。", style: C.muted }),
      allowlistBlock]);
  };

  // ── 回退：撤补丁 / 还原 home 指令 / 回到安装前 ──
  const paneRevert = () => {
    const info = el("div", { style: C.muted + ";margin-bottom:8px" });
    const bkList = el("div", { style: "margin:6px 0" });
    const sel = el("select", { style: C.input });
    const status = el("div", { style: C.muted + ";margin-top:6px" });

    const load = () => withBusy(async () => {
      const r = await callApi(api, "revert", ["list"]);
      bkList.replaceChildren();
      sel.replaceChildren();
      if (!r || r.ok === false) { info.textContent = "读取备份点失败：" + ((r && r.error) || ""); return; }
      info.textContent = r.count
        ? "可用回退点 " + r.count + " 个（目录：" + r.dir + "）"
        : "还没有备份点（目录：" + r.dir + "）——首次安装时会自动创建。";
      for (const b of r.backups || []) {
        sel.appendChild(el("option", { value: b.stamp, text: b.stamp + "（" + (b.files || []).length + " 个文件）" }));
        bkList.appendChild(el("div", { style: "font-size:11px;opacity:.7;margin:2px 0", text: b.stamp + "  " + (b.files || []).join(", ") }));
      }
    });
    load();

    const doRevert = (action, label, confirmMsg) => guard(confirmMsg, async () => {
      const payload = action === "home" || action === "all" ? { stamp: (sel.value || "").trim() } : {};
      const r = await callApi(api, "revert", [action, payload]);
      if (!r || r.ok === false) { status.textContent = label + "失败：" + ((r && r.error) || ""); showError(status.textContent); return; }
      showError("");
      const parts = [];
      if (r.reverted != null) parts.push("还原补丁 " + r.reverted + " 条");
      if (r.restored) parts.push("还原文件 " + r.restored.length + " 个" + (r.restored.length ? "（" + r.restored.join(", ") + "）" : ""));
      if (r.skipped && r.skipped.length) parts.push("跳过 " + r.skipped.length + " 个");
      status.textContent = label + "完成" + (parts.length ? "：" + parts.join("；") : "") + (r.stamp ? "（备份点 " + r.stamp + "）" : "");
      await load();
    });

    return el("div", {}, [
      el("div", { style: C.sect, text: "回退操作" }),
      el("div", { style: C.row }, [
        el("button", { text: "还原宿主补丁", style: C.btnDanger, onclick: doRevert("patches", "还原宿主补丁",
          "确定还原宿主补丁？会把 34+ 个宿主文件恢复原版，重启后适配失效，插件本身保留。") }),
        el("button", { text: "还原 home 指令", style: C.btn, onclick: doRevert("home", "还原 home 指令",
          "确定从备份还原 AGENTS.md / prompt-inject.md？当前文件会先另存一份 .before-revert-*。") }),
        el("button", { text: "全部回退", style: C.btnDanger, onclick: doRevert("all", "全部回退",
          "确定全部回退？会还原宿主补丁 + 从备份还原 home 指令。重启后回到打甲前状态。") }),
        el("button", { text: "刷新备份点", style: C.btn, onclick: load }),
      ]),
      info,
      el("div", { style: C.row + ";align-items:center" }, [
        el("span", { text: "备份点：", style: C.muted }),
        sel,
        el("button", { text: "还原到该备份点", style: C.btn, onclick: doRevert("home", "还原到指定备份点",
          "确定从所选备份点还原 home 指令？") }),
      ]),
      bkList,
      status,
      el("p", { text: "顺序建议：先「还原宿主补丁」→ 再「还原 home 指令」，两步都做完才算回到安装前。若要连插件一起删，用 CLI：node install.mjs --uninstall", style: C.muted }),
    ]);
  };

  // ── 规矩：AGENTS.md / AGENTS.security.md 读写 ──
  const paneRules = () => {
    const meta = el("div", { style: C.row });
    const sel = el("select", { style: C.input });
    for (const [v, label] of [
      ["home", "全局规矩（~/.dsh/AGENTS.md）"],
      ["security", "安全约定（AGENTS.security.md）"],
      ["workspace", "项目规矩（<工作区>/AGENTS.md）"],
    ]) sel.appendChild(el("option", { value: v, text: label }));
    // 工作区：用户显式设定，存到 ~/.dsh/dxkjailbreak/workspace.txt（不随请求变化）
    const wsInput = el("input", {
      type: "text",
      placeholder: "项目目录绝对路径（设定后可编辑项目级 AGENTS.md）",
      style: C.input + ";flex:1 1 300px;min-width:0",
    });
    const area = el("textarea", {
      style: "width:100%;min-height:300px;font-family:ui-monospace,Consolas,monospace;font-size:12px;box-sizing:border-box",
      spellcheck: "false",
    });
    const status = el("div", { style: C.muted + ";margin-top:4px" });
    // 请求序号：切换作用域时旧请求可能后返回，丢弃它，避免旧内容覆盖新作用域的编辑框
    let loadSeq = 0;
    // 已加载的作用域：保存时必须与下拉框一致，否则会把 A 的文本写进 B
    let loadedScope = "";
    let loadedRevision = "";
    const load = () => withBusy(async () => {
      const seq = ++loadSeq;
      loadedScope = "";
      loadedRevision = "";
      const scope = sel.value;
      const [l, r] = await Promise.all([
        callApi(api, "agentsFile", ["list"]),
        callApi(api, "agentsFile", ["read", { scope }]),
      ]);
      if (seq !== loadSeq || sel.value !== scope) return; // 过期结果丢弃
      meta.replaceChildren();
      if (l && l.rows) {
        for (const row of l.rows) {
          meta.appendChild(card(
            row.scope === "home" ? "全局" : row.scope === "security" ? "安全" : "项目",
            row.error ? "无法读取" : row.exists ? row.size + " 字节" : "未创建",
            shortPath(row.path)
          ));
        }
        // 回填当前工作区路径
        const wsRow = l.rows.find((x) => x.scope === "workspace");
        if (wsRow && wsRow.path && !wsInput.value) {
          wsInput.value = String(wsRow.path).replace(/[\\/]AGENTS\.md$/, "");
        }
      }
      if (!r || r.ok === false) {
        area.value = "";
        status.textContent = "读取失败：" + ((r && r.error) || "");
        return;
      }
      area.value = r.text || "";
      loadedScope = scope; // 记下这份内容属于哪个作用域
      loadedRevision = r.revision || "";
      status.textContent = r.missing
        ? "该作用域暂无文件，保存即创建。"
        : "已加载 " + r.chars + " 字；保存会先备份。";
    });
    sel.onchange = load;
    load();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [
        sel,
        el("button", { text: "读取", style: C.btn, onclick: load }),
        el("button", { text: "保存", style: C.btn, onclick: () => withBusy(async () => {
          // 守卫：编辑框里的内容属于 loadedScope，不是当前下拉框选的作用域时拒绝保存——
          // 否则「切到 B、B 还没加载完就点保存」会把 A 的正文写进 B 的文件。
          if (loadedScope !== sel.value) {
            status.textContent = "当前显示的是「" + (loadedScope || "未加载") + "」的内容，与所选「" + sel.value + "」不一致，已阻止保存。请先点『读取』。";
            return;
          }
          if (!loadedRevision) {
            status.textContent = "未取得文件版本，请确认前后端版本一致后重新读取。";
            return;
          }
          const r = await callApi(api, "agentsFile", ["save", { scope: sel.value, text: area.value, revision: loadedRevision }]);
          status.textContent = r && r.ok ? "已保存（" + r.chars + " 字）" : "保存失败：" + ((r && r.error) || "");
          if (r && r.ok) { showError(""); await load(); }
        }) }),
      ]),
      el("div", { style: C.row + ";align-items:center" }, [wsInput,
        el("button", { text: "设定工作区", style: C.btn, onclick: () => withBusy(async () => {
          const r = await callApi(api, "agentsFile", ["setWorkspace", { path: (wsInput.value || "").trim() }]);
          if (r && r.ok) {
            status.textContent = r.cleared ? "已清除工作区设定" : "工作区已设为 " + r.workspace;
            await load();
          } else {
            status.textContent = "设定失败：" + ((r && r.error) || "");
          }
        }) }),
        el("button", { text: "清除", style: C.btn, onclick: () => withBusy(async () => {
          wsInput.value = "";
          const r = await callApi(api, "agentsFile", ["setWorkspace", { path: "" }]);
          status.textContent = r && r.ok ? "已清除工作区设定" : "清除失败：" + ((r && r.error) || "");
          if (r && r.ok) await load();
        }) }),
      ]),
      meta, area, status,
      el("p", { text: "全局/安全作用于整机；项目规矩需要先设定工作区目录（存于 ~/.dsh/dxkjailbreak/workspace.txt）。", style: C.muted }),
    ]);
  };

  // ── 编成：profile 插件开关 ──
  const panePlugins = () => {
    const cards = el("div", { style: C.row });
    const body = el("div", {});
    const render = () => withBusy(async () => {
      const r = await callApi(api, "profilePlugins", ["list"]);
      cards.replaceChildren();
      body.replaceChildren();
      if (!r || r.ok === false) { body.appendChild(el("div", { text: "失败：" + ((r && r.error) || ""), style: "color:#d05050" })); return; }
      cards.appendChild(card("配置档案", r.profile, shortPath(r.path)));
      cards.appendChild(card("已启用", r.enabled + " / " + r.total, "重启生效"));
      const rows = r.rows || [];
      body.appendChild(table(["插件", "依赖", "启用", "操作"], rows, (p) => [
        el("td", { text: p.name, style: C.td + (p.ours ? ";font-weight:600" : "") }),
        el("td", { style: C.td }, [p.hostRequired ? badge("宿主", "#6b7fd7") : p.dependency ? badge("已安装", "#3aa675") : badge("缺失", "#d05050")]),
        el("td", { style: C.td }, [p.bundle ? badge("开", "#3aa675") : badge("关", "#8a8a8a")]),
        el("td", { style: C.td }, [
          p.hostRequired ? el("span", { text: "宿主必需", style: C.muted }) :
          !p.dependency && !p.bundle ? el("span", { text: "未安装", style: C.muted }) :
          el("button", {
            text: p.bundle ? "停用" : "启用", style: C.btn,
            onclick: () => withBusy(async () => {
              const res = await callApi(api, "profilePlugins", [p.bundle ? "disable" : "enable", { name: p.name }]);
              if (!res || res.ok === false) {
                showError("操作失败：" + ((res && res.error) || "未知错误"));
                return;
              }
              showError("");
              await render();
            }),
          }),
        ]),
      ]));
    });
    render();
    return el("div", {}, [
      el("div", { style: C.row }, [el("button", { text: "刷新", style: C.btn, onclick: render })]),
      cards, body,
      el("p", { text: "编成＝profile 的插件清单（package.json 的 dsh.profile.bundles）。停用不卸载，只是不再装配；每次改动都留 .bak 备份，重启 dsh web 生效。", style: C.muted }),
    ]);
  };

  // 展示自检实际返回的层得出的结论。
  const stepStrip = (sc) => {
    const layers = Array.isArray(sc.layers) ? sc.layers : [];
    const kinds = [["config", "配置"], ["host", "宿主"], ["runtime", "运行时"], ["layout", "文件布局"]];
    const wrap = el("div", { className: "dxk-checks", role: "group", "aria-label": "检测结果" });
    for (const [kind, label] of kinds) {
      const known = layers.filter(layer => layer?.kind === kind);
      const active = known.filter(layer => layer.applicable !== false);
      const status = known.length && !active.length ? "na"
        : active.some(layer => layer.state === "broken") ? "bad"
        : active.some(layer => layer.state === "pending") ? "pending"
        : active.length && active.every(layer => layer.ok && layer.state === "ok") ? "verified"
        : "unknown";
      wrap.appendChild(el("div", { className: "dxk-check", "data-status": status }, [
        el("span", { text: label }),
        el("strong", { text: { bad: "异常", pending: "待处理", verified: "已核验", na: "不适用", unknown: "未确认" }[status] }),
      ]));
    }
    return wrap;
  };

  // ── 区 3：完好性（逐 patch 表） ──
  const paneHealth = () => {
    const summary = el("div", { style: C.row });
    const body = el("div", {});
    let filter = "all";
    const render = async () => {
      if (!cache.patches) {
        const r = await callApi(api, "patches", []);
        if (!r || r.ok === false) { showError("补丁表读取失败：" + ((r && r.error) || "未知")); return; }
        cache.patches = r;
      }
      const { rows = [], summary: sum = {} } = cache.patches;
      summary.replaceChildren(
        card("总数", sum.total ?? rows.length, "可选 " + (sum.optional || 0)),
        card("已打", sum.applied || 0, "", "#3aa675"),
        card("待打", sum.pending || 0, "点「修复」或「开启」", sum.pending > 0 ? "#c9922e" : "#3aa675"),
        card("失配/异常", (sum.broken || 0), "需改锚点", sum.broken > 0 ? "#d05050" : "#3aa675"),
        card("不适用", sum.absent || 0, "未装组件/已过时/可选"),
      );
      const view = filter === "all" ? rows : rows.filter((r) => (filter === "issue" ? ["broken", "partial", "pending"].includes(r.status) : filter === "absent" ? ["unlocated", "missing_file", "not_applicable", "na", "skipped", "disabled", "off", "not_needed"].includes(r.status) : r.status === filter));
      body.replaceChildren(table(
        ["#", "补丁", "层", "状态", "原因"],
        view,
        (r) => [
          el("td", { text: String(r.id), style: C.td + ";opacity:.55" }),
          el("td", { text: r.name + (r.optional ? "（可选）" : ""), style: C.td }),
          el("td", { text: r.layer || "-", style: C.td + ";opacity:.75" }),
          el("td", { style: C.td }, [badge(STATUS_LABEL[r.status] || r.status, STATUS_COLOR[r.status] || "#8a8a8a")]),
          el("td", { text: r.note || "-", style: C.td + ";opacity:.6;font-size:11px" }),
        ]
      ));
    };
    const mkFilter = (key, label) => {
      const b = el("button", { text: label, style: C.btn, onclick: async () => { filter = key; await render(); } });
      return b;
    };
    const refresh = el("button", { text: "重新检测", style: C.btn, onclick: () => withBusy(async () => { cache.patches = null; cache.status = null; await render(); }) });
    render();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [refresh, mkFilter("all", "全部"), mkFilter("issue", "仅异常"), mkFilter("pending", "待打"), mkFilter("applied", "已打"), mkFilter("absent", "不适用")]),
      summary, el("div", { style: "margin-top:6px" }, [body]),
    ]);
  };


  // ── 区：对话管理（删除会话 / 回收站） ──
  // 用户要的「删除对话」：宿主 UI 没有这个入口。安全设计：
  //   ① 删除前必弹确认窗（显示完整 sessionId + 大小 + 时间 + 去处）
  //   ② 实际是「移到回收站」，不是 rm -rf —— 随时能恢复
  //   ③ 当前正在用的会话后端会拒删

  /** 会话管理走独立路由（console RPC 白名单是加载时快照，新增方法会 unknown）。 */
  const convCall = async (action, payload = {}) => {
    try {
      const readOnly = action === "list" || payload.dryRun === true;
      const response = await fetch("/dxkjailbreak/conversations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload }),
        signal: readOnly && typeof AbortSignal !== "undefined" ? AbortSignal.timeout?.(20000) : undefined,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, error: result?.error || "HTTP " + response.status };
      if (!result || typeof result.ok !== "boolean") return { ok: false, error: "会话服务返回了无效响应。" };
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error?.name === "TimeoutError" ? "会话请求超时，请重试。" : String(error?.message || error),
      };
    }
  };
  const paneConversations = () => {
    let rows = [];
    let disposed = false;
    let listRequest = 0;
    const deleting = new Set();
    const closeConfirmation = { cancel: null };
    const cards = el("div", { className: "dxk-session-summary" });
    const message = el("p", { role: "status", className: "dxk-session-message", text: "正在读取会话…" });
    const count = el("span", { className: "dxk-result-count", role: "status" });
    const search = el("input", { type: "search", "aria-label": "筛选对话", placeholder: "按会话 ID 或工作区筛选", style: C.input });
    const filterBar = el("div", { className: "dxk-session-filter", hidden: true }, [search, count]);
    const list = el("div", { className: "dxk-session-list" });
    const feedback = el("p", { role: "status", className: "dxk-session-note", hidden: true });
    const showFeedback = (text) => {
      feedback.textContent = text;
      feedback.hidden = !text;
    };

    /** 确认弹窗：必须点「确认删除」才返回 true。 */
    const confirmDelete = (row) => new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const mask = el("div", {
        role: "alertdialog", "aria-modal": "true", "aria-label": "确认删除对话",
        style: "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px",
      });
      const panel = el("div", {
        style: "max-width:520px;width:100%;background:#24262d;color:#e8e8e8;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.6);font-size:13px",
      });
      panel.appendChild(el("div", { style: "font-size:15px;font-weight:600;margin-bottom:10px" }, "确认删除这个对话？"));
      panel.appendChild(el("div", {
        style: "font-family:ui-monospace,monospace;font-size:12px;background:rgba(0,0,0,.28);border-radius:8px;padding:10px;margin-bottom:12px;word-break:break-all",
      }, [
        el("div", {}, "会话 ID：" + row.sessionId),
        el("div", {}, "工作区：" + row.workspace),
        el("div", {}, "大小：" + row.sizeText + "　时间：" + row.timeText),
        el("div", {}, "去处：" + "Windows 系统回收站（可从系统回收站还原）"),
      ]));
      panel.appendChild(el("p", {
        style: "margin:0 0 14px;color:#ffb27a;font-size:12px",
      }, "对话会移入 Windows 回收站。还原文件后，在 DSH 的已归档列表中取消归档，即可重新显示在侧栏。"));
      const btns = el("div", { style: "display:flex;gap:8px;justify-content:flex-end" });
      const cancel = el("button", { text: "取消", style: C.btn, onclick: () => finish(false) });
      const okBtn = el("button", {
        text: "确认删除",
        style: C.btn + ";background:#8c2d2d;color:#fff;border-color:#a33",
        onclick: () => finish(true),
      });
      btns.appendChild(cancel);
      btns.appendChild(okBtn);
      panel.appendChild(btns);
      mask.appendChild(panel);
      const onKey = (event) => {
        if (event.key === "Escape") { event.preventDefault(); finish(false); return; }
        if (event.key === "Tab") {
          event.preventDefault();
          (document.activeElement === cancel ? okBtn : cancel).focus();
        }
      };
      const finish = (accepted) => {
        if (!closeConfirmation.cancel) return;
        closeConfirmation.cancel = null;
        mask.remove();
        document.removeEventListener("keydown", onKey);
        previousFocus?.focus();
        resolve(accepted);
      };
      closeConfirmation.cancel = () => finish(false);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(mask);
      cancel.focus();
    });

    const deleteRow = async (row) => {
      if (closeConfirmation.cancel || deleting.has(row.sessionId) || !await confirmDelete(row)) return;
      deleting.add(row.sessionId);
      try {
        await withBusy(async () => {
          const preview = await convCall("delete", { sessionId: row.sessionId, dryRun: true });
          if (!preview.ok) {
            if (!disposed) showError("不能删除：" + preview.error);
            return;
          }
          const result = await convCall("delete", {
            sessionId: row.sessionId,
            confirmSessionId: row.sessionId,
            dryRun: false,
          });
          if (disposed) return;
          if (!result.ok) {
            showError("删除失败：" + result.error);
            return;
          }
          showError("");
          showFeedback("对话已移入 Windows 回收站。");
          rows = rows.filter(item => item.sessionId !== row.sessionId);
          drawSummary();
          drawRows();
          await load();
        });
      } finally {
        deleting.delete(row.sessionId);
        if (!disposed) drawRows();
      }
    };

    const drawSummary = () => {
      const bytes = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
      const size = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
      cards.replaceChildren(card("对话总数", String(rows.length)), card("占用空间", size));
    };
    const updatedAt = (row) => {
      const date = Number.isFinite(row.mtime) && row.mtime > 0 ? new Date(row.mtime) : null;
      if (!date || !Number.isFinite(date.getTime())) return row.timeText || "—";
      return el("time", { className: "dxk-session-time", datetime: date.toISOString() }, [
        el("span", { text: date.toLocaleDateString() }),
        el("span", { text: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
      ]);
    };
    const drawRows = () => {
      const query = String(search.value || "").trim().toLowerCase();
      const visible = rows.filter(row => !query || row.sessionId.toLowerCase().includes(query)
        || String(row.workspace || "").toLowerCase().includes(query));
      filterBar.hidden = rows.length === 0;
      count.textContent = query ? "显示 " + visible.length + " / " + rows.length + " 条" : "共 " + rows.length + " 条";
      if (!visible.length) {
        if (query && rows.length) list.replaceChildren(el("p", { text: "没有匹配的会话。", className: "dxk-session-message" }));
        else list.replaceChildren();
        return;
      }
      list.replaceChildren(table(
        ["会话 / 工作区", "更新时间", "大小", "操作"],
        visible,
        (row) => [
          el("td", { style: C.td }, [
            el("span", { style: "font-family:ui-monospace,monospace;font-size:11px", title: row.sessionId },
              row.sessionId.length > 24 ? row.sessionId.slice(0, 24) + "…" : row.sessionId),
            el("span", { className: "dxk-session-workspace", text: row.workspace || "未分组" }),
          ]),
          el("td", { style: C.td }, updatedAt(row)),
          el("td", { style: C.td, text: row.sizeText || "—" }),
          el("td", { style: C.td }, [
            el("button", { text: "删除", style: C.btnDanger, disabled: deleting.has(row.sessionId),
              "aria-label": "删除会话 " + row.sessionId, onclick: () => deleteRow(row) }),
          ]),
        ],
      ));
    };
    search.addEventListener("input", drawRows);

    const load = () => withBusy(async () => {
      const request = ++listRequest;
      const result = await convCall("list");
      if (disposed || request !== listRequest) return;
      if (!result.ok || !Array.isArray(result.sessions)) {
        message.textContent = "读取会话失败。 " + (result.error || "会话列表格式无效。");
        message.hidden = false;
        return;
      }
      rows = result.sessions.filter(row => typeof row?.sessionId === "string" && row.sessionId);
      drawSummary();
      drawRows();
      message.textContent = rows.length ? "" : "当前没有会话。";
      message.hidden = rows.length > 0;
    });
    const toolbar = el("div", { className: "dxk-session-toolbar" }, [
      el("h3", { text: "对话管理" }),
      el("div", { className: "dxk-session-actions" }, [
        el("button", { text: "刷新列表", style: C.btn, onclick: load }),
        el("button", { text: "检查未分组会话", style: C.btn, onclick: () => withBusy(async () => {
          const result = await convCall("cleanup", { dryRun: true });
          if (disposed) return;
          if (!result.ok) showError("检查失败：" + result.error);
          else {
            showError("");
            showFeedback(result.note || "检查完成。");
          }
        }) }),
      ]),
    ]);
    const pane = el("div", { className: "dxk-conversations" }, [toolbar, cards,
      el("p", { className: "dxk-session-note", text: "删除的对话可在 Windows 回收站中还原。" }),
      message, feedback, filterBar, list]);
    pane.__dxkDispose = () => {
      disposed = true;
      closeConfirmation.cancel?.();
    };
    load();
    return pane;
  };

  // ── 区 4：修复 ──
  const paneRepair = () => {
    const out = el("pre", { style: C.pre });
    const run = el("button", { text: "修复（markersAny 重锚）", style: C.btn, onclick: () => withBusy(async () => {
      const r = await callApi(api, "repair", []);
      out.textContent = JSON.stringify(r, null, 2);
      if (!r || r.ok === false) showError("修复失败：" + ((r && r.error) || "未知"));
      else { showError(""); cache.patches = null; cache.status = null; }
    }) });
    return el("div", {}, [
      el("div", { style: C.row }, [run]),
      el("p", { text: "按 markersAny 双形态重锚失配补丁；目标缺失的条目会自动降级（silentWhenMissing），不会把宿主改坏。", style: C.muted }),
      out,
    ]);
  };

  // ── 区 5：记忆 ──
  const paneMemory = () => {
    const out = el("pre", { style: C.pre });
    const modeInput = el("input", { placeholder: "模式（默认 dxkjailbreak）", style: C.input + ";min-width:180px" });
    const qInput = el("input", { placeholder: "检索关键词（留空=列表）", style: C.input });
    const act = async (action, payload, label) => withBusy(async () => {
      const r = await callApi(api, "memory", [action, payload]);
      out.textContent = JSON.stringify(r, null, 2);
      if (!r || r.ok === false) showError(label + "失败：" + ((r && r.error) || "未知"));
      else showError("");
      return r;
    });
    const mode = () => (modeInput.value || "").trim() || "dxkjailbreak";
    const fromInput = el("input", { placeholder: "旧模式名（如 pentest）", style: C.input + ";min-width:180px" });
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [modeInput, qInput,
        el("button", { text: "查询/列表", style: C.btn, onclick: () => act("list", qInput.value ? { mode: mode(), query: qInput.value } : { mode: mode() }, "查询") }),
        el("button", { text: "导出", style: C.btn, onclick: async () => {
          const r = await act("export", { mode: mode() }, "导出");
          if (r && r.ok) {
            try {
              const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "dxkjailbreak-memory-" + mode() + ".json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            } catch { /* 下载不可用则结果仍在下方 */ }
          }
        } }),
      ]),
      el("div", { style: C.row + ";align-items:center" }, [fromInput,
        el("button", { text: "迁移旧模式→当前", style: C.btn, onclick: () => withBusy(async () => {
          const from = (fromInput.value || "").trim();
          if (!from) { showError("先填旧模式名（如 pentest / code-audit）"); return; }
          if (typeof window !== "undefined" && typeof window.confirm === "function"
            && !window.confirm("确定把 " + from + " 下的记忆整体迁移到 " + mode() + "？正文不动，只改归属。")) return;
          await act("migrate", { from, to: mode() }, "迁移");
        }) }),
        el("button", { text: "清除当前模式全部记忆", style: C.btnDanger, onclick: guard(
          "确定清除？该模式下的记忆会被逐条删除（过期项也包含），不可撤销。",
          () => act("clear", { mode: mode() }, "清除")) }),
      ]),
      el("p", { text: "记忆为模式作用域；单卡模式检索会自动跨十模式召回。导出含全文，注意存放位置。", style: C.muted }),
      out,
    ]);
  };

  // ── 区 6：审计 ──
  const paneAudit = () => {
    const body = el("div", {});
    const limitSel = el("input", { type: "number", value: "50", min: "1", max: "500", style: C.input + ";min-width:80px" });
    const render = async () => withBusy(async () => {
      const r = await callApi(api, "audit", [{ limit: Number(limitSel.value) || 50 }]);
      if (!r || r.ok === false) {
        body.replaceChildren(el("div", { text: "读取失败：" + ((r && r.error) || "未知"), style: "color:#d05050" }));
        return;
      }
      const rows = r.rows || [];
      body.replaceChildren(
        el("div", { text: "共 " + rows.length + " 条（新在前）", style: C.muted + ";margin-bottom:4px" }),
        table(["时间", "事件", "详情"], rows, (row) => [
          el("td", { text: String(row.at || "").replace("T", " ").replace("Z", ""), style: C.td + ";opacity:.8" }),
          el("td", { style: C.td }, [badge(String(row.event || "—"), "#6b7fd7")]),
          el("td", { text: auditDetail(row), style: C.td + ";opacity:.8" }),
        ])
      );
    });
    render();
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [
        el("button", { text: "刷新", style: C.btn, onclick: render }),
        el("label", { style: C.muted }, ["条数 ", limitSel]),
      ]),
      el("p", { text: "记录插件自己的改动动作（apply/revert/boost/preset 等）；写不进去不影响主流程。", style: C.muted }),
      body,
    ]);
  };

  // ── 区 7：狩猎 ──
  const paneHunter = () => {
    const out = el("pre", { style: C.pre });
    const input = el("input", { placeholder: "FOFA / Quake DSL 查询", style: C.input + ";flex:1 1 260px" });
    const run = () => withBusy(async () => {
      const r = await callApi(api, "hunter", ["query", { query: input.value }]);
      out.textContent = JSON.stringify(r, null, 2);
      if (!r || r.ok === false) showError("查询失败：" + ((r && r.error) || "未知"));
      else showError("");
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    return el("div", {}, [
      el("div", { style: C.row + ";align-items:center" }, [input, el("button", { text: "解析 DSL", style: C.btn, onclick: run })]),
      el("p", { text: "DSL 解析与限额查询走 hunter 适配器；API Key 在「狩猎」原始页面配置。", style: C.muted }),
      out,
    ]);
  };

  // ── 区 8：MCP ──
  const paneMcp = () => {
    const out = el("pre", { style: C.pre });
    const run = () => withBusy(async () => {
      const r = await callApi(api, "mcp", ["list", {}]);
      out.textContent = JSON.stringify(r, null, 2);
      if (!r || r.ok === false) showError("MCP 读取失败：" + ((r && r.error) || "未知"));
      else showError("");
    });
    run();
    return el("div", {}, [
      el("div", { style: C.row }, [el("button", { text: "刷新连接", style: C.btn, onclick: run })]),
      el("p", { text: "复用 mcp-studio 的设置 RPC；连接增删去 mcp-studio 原页面。", style: C.muted }),
      out,
    ]);
  };

  const GROUPS = {
    军械整备: { 状态: paneStatus, 甲片: paneHealth, 补甲: paneRepair, 军令: panePromptFile, 规矩: paneRules, 门禁: paneHooks, 总闸: paneToggle, 回退: paneRevert, 编制: panePreset, 战例: paneMemory, 日志: paneAudit },
    作战沙盘: { 侦察: paneTargets, 装备: paneEnv, 分队: paneAgents, 暗道: paneTunnels, 突破口: paneVulns, 路线: paneChain, 战功: paneScore, 战报: paneReport, 参谋: paneOps },
    附属: { 对话: paneConversations, 编成: panePlugins, 狩猎: paneHunter, MCP: paneMcp },
  };
  const groupBar = el("div", { className: "dxk-nav", role: "group", "aria-label": "控制台分组" });
  const bar = el("div", { className: "dxk-nav", role: "tablist", "aria-label": "控制台页签" });
  const body = el("div", { id: panelId, className: "dxk-panel", role: "tabpanel", tabindex: "0" });
  let curGroup = "军械整备";
  let curTab = "状态";
  const saveTabChoice = () => { try { if (typeof localStorage !== "undefined") localStorage.setItem("dxkjailbreak:tab", JSON.stringify({ group: curGroup, tab: curTab })); } catch { /* 隐私模式/配额：不记忆就是了 */ } };
  try {
    const saved = typeof localStorage !== "undefined" ? JSON.parse(localStorage.getItem("dxkjailbreak:tab") || "null") : null;
    if (saved && Object.hasOwn(GROUPS, saved.group) && Object.hasOwn(GROUPS[saved.group], saved.tab)) { curGroup = saved.group; curTab = saved.tab; }
  } catch { /* 记忆坏了回默认 */ }
  let currentPane = null;
  /* 换面板必须先把旧面板的定时器清掉：页签切换是 replaceChildren，
     不触发 React 卸载，旧 pane 的 __dxkDispose 不会被自动调用。
     不换这一处，开启「每 10 秒自动刷新」后反复切页签会累积多个定时器
     。 */
  const swapPane = (make) => {
    paneVersion++;
    showError("");
    try {
      if (currentPane && typeof currentPane.__dxkDispose === "function") currentPane.__dxkDispose();
    } catch { /* 清理失败不影响换页 */ }
    try {
      currentPane = make();
    } catch {
      currentPane = el("p", { role: "status", text: "此面板无法加载。" });
    }
    body.replaceChildren(currentPane);
    // 关闭整个控制台（DomBridge 卸载）时也要能清到当前面板的定时器：
    // 把 currentPane 的 dispose 代理到 root 节点上，DomBridge 的清理链就能找到它。
    root.__dxkDispose = () => {
      try { if (currentPane && typeof currentPane.__dxkDispose === "function") currentPane.__dxkDispose(); } catch {}
    };
  };
  const selectTab = (tab) => {
    if (tab === curTab) {
      bar.querySelector('[aria-selected="true"]')?.focus();
      return;
    }
    curTab = tab;
    saveTabChoice();
    drawTabs();
    swapPane(() => GROUPS[curGroup][tab]());
    bar.querySelector('[aria-selected="true"]')?.focus();
  };
  const drawTabs = () => {
    bar.replaceChildren();
    const tabs = Object.keys(GROUPS[curGroup]);
    for (const [index, tab] of tabs.entries()) {
      const id = panelId + "-tab-" + index;
      const active = tab === curTab;
      if (active) body.setAttribute("aria-labelledby", id);
      bar.appendChild(el("button", {
        id,
        type: "button",
        text: tab,
        style: C.btn + (active ? ";font-weight:700" : ";opacity:.75"),
        role: "tab",
        "aria-controls": panelId,
        "aria-selected": active ? "true" : "false",
        tabindex: active ? "0" : "-1",
        onclick: () => selectTab(tab),
        onkeydown: (event) => {
          const target = {
            ArrowLeft: (index + tabs.length - 1) % tabs.length,
            ArrowRight: (index + 1) % tabs.length,
            ArrowUp: (index + tabs.length - 1) % tabs.length,
            ArrowDown: (index + 1) % tabs.length,
            Home: 0,
            End: tabs.length - 1,
          }[event.key];
          if (typeof target !== "number") return;
          event.preventDefault();
          selectTab(tabs[target]);
        },
      }));
    }
  };
  const drawGroups = () => {
    groupBar.replaceChildren();
    for (const group of Object.keys(GROUPS)) {
      const active = group === curGroup;
      groupBar.appendChild(el("button", {
        type: "button",
        text: group,
        style: C.btn + (active ? ";font-weight:700" : ";opacity:.7"),
        "aria-pressed": active ? "true" : "false",
        onclick: () => {
          if (group === curGroup) return;
          curGroup = group;
          curTab = Object.keys(GROUPS[group])[0];
          saveTabChoice();
          drawGroups();
          drawTabs();
          swapPane(() => GROUPS[group][curTab]());
          groupBar.querySelector('[aria-pressed="true"]')?.focus();
        },
      }));
    }
  };
  drawGroups(); drawTabs();

  root.appendChild(consoleStyles());
  root.appendChild(header);
  root.appendChild(errBar);
  root.appendChild(busy);
  root.appendChild(el("div", { className: "dxk-layout" }, [
    el("nav", { className: "dxk-nav-shell", "aria-label": "控制台导航" }, [groupBar, bar]),
    body,
  ]));
  swapPane(() => GROUPS[curGroup][curTab]());
  return root;
}

function shortPath(p) {
  if (!p || typeof p !== "string") return "-";
  const home = (typeof process !== "undefined" && process.env && (process.env.USERPROFILE || process.env.HOME)) || "";
  let out = p;
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = "~" + out.slice(home.length);
  return out.length > 42 ? "…" + out.slice(-40) : out;
}

function auditDetail(row) {
  const skip = new Set(["at", "event", "pid"]);
  const parts = [];
  for (const [k, v] of Object.entries(row || {})) {
    if (skip.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(k + "=" + (s.length > 60 ? s.slice(0, 58) + "…" : s));
  }
  return parts.join(" · ");
}
