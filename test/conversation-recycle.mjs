import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { archiveAndRecycle } from "../lib/conversation-recycle.js";
import { captureRewindAgentLifecycle, lockSessionMutation } from "../lib/rewind.js";

function fixture(archivedSessionIds = []) {
  const calls = [];
  const registry = {
    archivedSessionIds, pinnedSessionIds: ["session-fixture"],
    archiveSession: async id => { calls.push("archive"); archivedSessionIds.push(id); },
    unarchiveSession: async () => { calls.push("unarchive"); archivedSessionIds.pop(); },
    pinSession: async () => { calls.push("pin"); },
  };
  const services = { workspaceRegistry: registry, sessions: new Map(), agents: new Map() };
  const ctx = { get: key => services[key] };
  return { calls, registry, services, ctx };
}
test("the sidebar is updated before the file is recycled", async () => {
  const { ctx, calls } = fixture();
  const result = await archiveAndRecycle(ctx, "session-fixture", async () => calls.push("recycle"));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["archive", "recycle"]);
});
test("a recycling failure restores the original sidebar and pin state", async () => {
  const { ctx, calls } = fixture();
  const result = await archiveAndRecycle(ctx, "session-fixture", async () => { throw Error("locked"); });
  assert.equal(result.ok, false);
  assert.match(result.error, /locked/);
  assert.deepEqual(calls, ["archive", "unarchive", "pin"]);
});
test("archive refusal leaves the session file untouched", async () => {
  const { ctx, registry } = fixture();
  registry.archiveSession = async () => { throw Error("active"); };
  const result = await archiveAndRecycle(ctx, "session-fixture", () => assert.fail("file move executed"));
  assert.equal(result.ok, false);
  assert.match(result.error, /active/);
});
test("release a loaded conversation before recycling and guard its identity during the move", async t => {
  const { ctx, services, calls } = fixture();
  const sessionId = "session-fixture";
  const live = { header: { id: sessionId } };
  const agent = {
    session: live, phase: { kind: "idle" },
    inbox: { current: () => ({ "next-turn": [], "next-step": [] }) },
  };
  const loop = {
    prepare(_owner, id) {
      if (id !== sessionId) return { agent: {} };
      services.sessions.set(sessionId, live);
      services.agents.set(sessionId, agent);
      return {
        agent, async dispose() {
          calls.push("dispose");
          services.sessions.delete(sessionId);
          services.agents.delete(sessionId);
        },
      };
    },
  };
  t.after(captureRewindAgentLifecycle(loop));
  loop.prepare(null, sessionId);
  agent.phase.kind = "running";
  const active = await archiveAndRecycle(ctx, sessionId, () => assert.fail("active conversation moved"));
  assert.equal(active.ok, false);
  assert.deepEqual(calls, ["archive", "unarchive", "pin"]);
  assert.strictEqual(services.agents.get(sessionId), agent);
  calls.length = 0;
  agent.phase.kind = "idle";

  const deleted = await archiveAndRecycle(ctx, sessionId, async () => {
    assert.equal(services.sessions.has(sessionId), false);
    assert.equal(services.agents.has(sessionId), false);
    assert.throws(() => loop.prepare(null, sessionId), /回收站/);
    assert.doesNotThrow(() => loop.prepare(null, "session-other"));
    assert.equal(lockSessionMutation(sessionId, "rewind"), null);
    calls.push("recycle");
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(calls, ["archive", "dispose", "recycle"]);
  const unlock = lockSessionMutation(sessionId, "rewind");
  assert.equal(typeof unlock, "function");
  unlock();
});
test("the conversations route dispatches GET only for listing", async () => {
  const source = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const route = source.match(/registerPluginRoute\(\{\s*kind: "exact",\s*path: "\/dxkjailbreak\/conversations",[\s\S]*?\}, "dxkjailbreak: conversations"\);/);
  assert.ok(route, "production conversations route found");
  let handler;
  const calls = [];
  vm.runInNewContext(route[0], {
    URL,
    registerPluginRoute: spec => { handler = spec.handler; },
    readJsonBody: async request => JSON.parse(request.body),
    consoleApi: { conversations: async action => { calls.push(action); return { ok: true }; } },
    sendJson: (response, status) => response.writeHead(status),
  });
  async function request(method, url, body) {
    let status;
    await handler({ method, url, body }, { writeHead: code => { status = code; }, end() {} });
    return status;
  }
  const url = "/dxkjailbreak/conversations";
  assert.equal(await request("GET", url), 200);
  for (const action of ["delete", "cleanup"]) {
    assert.equal(await request("GET", url + "?action=" + action), 405);
  }
  assert.deepEqual(calls, ["list"]);
  assert.equal(await request("POST", url, JSON.stringify({ action: "delete" })), 200);
  assert.deepEqual(calls, ["list", "delete"]);
});
test("the delete API broadcasts removal only after a successful recycle", async () => {
  const source = fs.readFileSync(new URL("../lib/console-api.js", import.meta.url), "utf8");
  const entry = source.indexOf("export async function conversations(");
  const start = source.indexOf('if (action === "delete") {', entry);
  const end = source.indexOf('if (action === "cleanup") {', start);
  assert.ok(entry >= 0 && start > entry && end > start);
  const actions = [];
  const id = "session-fixture";
  const ctx = { emit: (event, sessionId) => { actions.push([event, sessionId]); } };
  let fail = false;
  const run = vm.runInNewContext("(async (action, payload) => {" + source.slice(start, end) + "})", {
    process: { platform: "win32" },
    assertSafeSessionDir: sessionId => ({ ok: true, hit: { sessionId }, real: "fixture-path" }),
    safe: fn => fn(),
    __dxkRewindCtx: ctx,
    archiveAndRecycle: async (authority, sessionId, move) => {
      assert.equal(authority, ctx);
      assert.equal(sessionId, id);
      if (fail) return { ok: false };
      await move();
      return { ok: true };
    },
    sendToRecycleBin: async () => { actions.push(["move"]); },
  });
  const payload = { sessionId: id, confirmSessionId: id, dryRun: false };
  fail = true;
  assert.equal((await run("delete", payload)).ok, false);
  assert.deepEqual(actions, []);
  fail = false;
  assert.equal((await run("delete", payload)).ok, true);
  assert.deepEqual(actions, [["move"], ["api-session/removed", id]]);
});
test("the sidebar confirmation binds the clicked ID and cancel sends nothing", async () => {
  let descriptor;
  const requests = [];
  const sidebarMutations = [];
  const id = "session-00000000-0000-0000-0000-000000000000";
  const other = "session-00000000-0000-0000-0000-000000000001";
  let catalog = [id, other];
  const sessions = {
    handleSessionRemoved(sessionId) {
      sidebarMutations.push(sessionId);
      catalog = catalog.filter(id => id !== sessionId);
    },
    async refresh() {
      // DSH can merge a pull started before this deletion. Reapply its in-flight mutations.
      catalog = [id, other].filter(id => !sidebarMutations.includes(id));
    },
  };
  const node = tag => ({
    tag, style: {}, children: [], setAttribute() {}, focus() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter(n => n !== child); },
  });
  const document = { body: node("body"), createElement: node, addEventListener() {}, removeEventListener() {} };
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { descriptor = value; } } },
    document, setTimeout: () => 0,
    fetch: async (url, options) => {
      requests.push([url, JSON.parse(options.body)]);
      return { json: async () => ({ ok: true, moved: { sessionId: id } }) };
    },
  };
  const client = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
  vm.createContext(sandbox);
  vm.runInContext(client.replace("module.exports = { name:", "globalThis.confirmDelete = dxkConfirmDeleteDialog;\nglobalThis.setHostSessions = value => { __dxkHostSessions = value; };\nmodule.exports = { name:"), sandbox);
  descriptor.factory(() => ({}));
  sandbox.setHostSessions(sessions);
  sandbox.confirmDelete(id);
  assert.deepEqual(requests, []);
  const controls = () => document.body.children[0].children[0].children[3].children;
  controls()[0].onclick();
  assert.deepEqual(requests, []);
  sandbox.confirmDelete(id);
  const confirm = controls()[1];
  confirm.onclick();
  confirm.onclick();
  assert.deepEqual(requests, [["/dxkjailbreak/conversations", {
    action: "delete", payload: { sessionId: id, confirmSessionId: id, dryRun: false },
  }]]);
  assert.deepEqual(catalog, [id, other]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sidebarMutations, [id]);
  assert.deepEqual(catalog, [other]);
});
