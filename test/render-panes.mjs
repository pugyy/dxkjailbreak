import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const { version: packageVersion } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const fixtures = {
  status: {
    ok: true, version: "fixture",
    selfcheck: {
      ok: false, state: "unknown", patch: { applied: 1, total: 3 },
      layers: [{ kind: "host", ok: true, state: "ok" }, { kind: "runtime", ok: false, state: "unknown" }],
    },
  },
  preset: { ok: true, presets: [{ id: "fixture", title: "测试预设", isDefault: true }, null] },
  patches: { ok: true, rows: [{ id: 1, name: "Fixture", layer: "host", status: "pending" }], summary: { applied: 0, total: 1, pending: 1 } },
  audit: { ok: true, rows: [{ at: "2026-11-21T00:00:00Z", event: "fixture" }] },
  redteam: { ok: true, rows: [], sessions: [], items: [] },
  agentsFile: { ok: true, rows: [], text: "placeholder", revision: "fixture" },
  conversations: {
    ok: true,
    sessions: [{ sessionId: "session-00000000-0000-0000-0000-000000000000", workspace: "演示工作区", timeText: "2026-11-21T10:00:00Z", size: 2048, sizeText: "2 KB" }],
    trash: [],
  },
  profilePlugins: {
    ok: true, profile: "desktop", enabled: 1, total: 2, path: "fixture/package.json",
    rows: [
      { name: "@deepseek-ai/dsh-base", dependency: false, bundle: true, hostRequired: true },
      { name: "fixture-plugin", dependency: true, bundle: false },
    ],
  },
};
const flush = () => new Promise(resolve => setImmediate(resolve));
function elements(node) {
  return [node, ...(node.children ?? []).flatMap(elements)];
}
function node(tag) {
  return {
    tag, children: [], style: {}, events: {}, disabled: false,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this[key] = value; },
    addEventListener(key, callback) { this.events[key] = callback; },
    focus() { this.focused = true; },
    querySelector(selector) {
      const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
      return match ? elements(this).find(n => n[match[1]] === match[2]) : null;
    },
    click() { return this.events.click?.({ preventDefault() {}, currentTarget: this }); },
  };
}

const empty = { ok: true, rows: [], items: [], backups: [], presets: [], origins: [], sessions: [], trash: [] };
for (const scenario of ["有数据", "空数据", "HTTP 503"])
for (const file of ["client.js", "client.settings.js"]) {
  const source = fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
  const document = { createElement: node, createTextNode: text => ({ textContent: text }), body: node("body") };
  let descriptor, view;
  let fail = scenario === "HTTP 503";
  const ctx = vm.createContext({
    document,
    window: { __ModuleLoader__: { load(value) { descriptor = value; } } },
    fetch: async (url, opts) => {
      const method = JSON.parse(opts.body).method;
      const fixture = url === "/dxkjailbreak/conversations" ? fixtures.conversations : fixtures[method];
      const result = fail ? { ok: false, error: "暂时不可用" } : (scenario === "有数据" ? fixture ?? empty : empty);
      return { ok: !fail, status: fail ? 503 : 200, json: async () => result };
    },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal,
  });
  let root;
  if (file === "client.js") {
    vm.runInContext(source, ctx);
    const client = descriptor.factory(() => ({ createElement: (type, props) => ({ type, props }) }));
    client.apply({ slots: {
      inject: (_name, register) => register(),
      register(spec, callback) { if (spec.name === "settings.section") view = callback; return () => {}; },
    } });
    root = view().props.render();
  } else {
    root = vm.runInContext(source + "\nrenderConsole({})", ctx);
  }
  const header = elements(root).find(n => n.tag === "header");
  assert.ok(header && elements(header).some(n => n.textContent === "by dxk"), "显示插件作者");
  assert.ok(elements(header).some(n => n.className === "dxk-version" && n.textContent === "v" + packageVersion), "页眉版本和发布清单一致");
  const author = elements(header).find(n => n.className === "dxk-author");
  const homepage = author?.children.find(n => n.tag === "a");
  assert.equal(homepage?.textContent, "github.com/pugyy/dxkjailbreak");
  assert.equal(homepage?.href, "https://github.com/pugyy/dxkjailbreak");
  assert.equal(homepage?.target, "_blank");
  assert.equal(homepage?.rel, "noopener noreferrer");
  const brand = elements(header).find(n => n.tag === "img");
  assert.equal(brand?.src, "/dxkjailbreak/brand.png");
  assert.equal(brand?.alt, "");
  let visited = 0;
  for (const group of elements(root).filter(n => n["aria-pressed"] != null)) {
    const button = elements(root).find(n => n["aria-pressed"] != null && n.textContent === group.textContent);
    await button.click();
    const tabs = elements(root).filter(n => n.role === "tab").map(n => n.textContent);
    for (const label of tabs) {
      await elements(root).find(n => n.role === "tab" && n.textContent === label).click();
      await flush();
      const selected = elements(root).find(n => n.role === "tab" && n["aria-selected"] === "true");
      const panel = elements(root).find(n => n.role === "tabpanel");
      assert.equal(selected?.textContent, label);
      assert.equal(selected?.focused, true);
      assert.equal(panel["aria-labelledby"], selected.id);
      assert.ok(panel.children.length > 0);
      assert.ok(!elements(panel).some(n => n.textContent === "此面板无法加载。"), `Failed to render ${file} /${label}`);
      assert.ok(!elements(root).some(n => n.role === "alert" && n.textContent?.startsWith("操作失败：")), `Async rendering failed for ${file} /${label}`);
      if (label === "状态" && scenario === "有数据") {
        assert.ok(elements(panel).some(n => n.textContent === "未确认"), "自检结论不能误报就绪");
        assert.ok(!elements(panel).some(n => n.textContent === "启动器" || n.textContent === "闪窗"));
      }
      if (label === "编成" && scenario === "有数据") {
        assert.ok(elements(panel).some(n => n.textContent === "宿主必需"));
        assert.ok(elements(panel).some(n => n.textContent === "启用"));
      }
      if (label === "对话" && scenario === "有数据") {
        const table = elements(panel).find(n => n.tag === "table");
        const body = table?.children.find(n => n.tag === "tbody");
        const cells = body?.children[0]?.children;
        assert.deepEqual(Array.from(cells ?? [], n => n.tag), ["td", "td", "td", "td"]);
        assert.equal(cells[0].children[0].title, fixtures.conversations.sessions[0].sessionId);
        assert.equal(cells[2].textContent, "2 KB");
        assert.equal(cells[3].children[0].textContent, "删除");
        const filter = elements(panel).find(n => n.type === "search");
        filter.value = "nonexistent";
        filter.events.input();
        assert.ok(elements(panel).some(n => n.textContent === "没有匹配的会话。"));
        filter.value = "演示工作区";
        filter.events.input();
        assert.ok(elements(panel).some(n => n.textContent === "删除"));
      }
      visited++;
    }
  }
  fail = true;
  const group = elements(root).find(n => n["aria-pressed"] != null && n.textContent === "军械整备");
  await group.click();
  await elements(root).find(n => n.tag === "button" && n.textContent === "刷新").click();
  await flush();
  assert.ok(elements(root).some(n => n.textContent === "读取失败"), "503 status must not appear as success");
  root.__dxkDispose?.();
  console.log(file + " " + scenario + " — " + visited + " 个实际页签通过");
}
