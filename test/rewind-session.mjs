import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { applyInplaceRewind, applyRewind, captureRewindAgentLifecycle } from "../lib/rewind.js";

const sourceId = "session-original";
const childId = "session-fork";
const event = (seq, type, data = {}) => ({ seq, type, data });
const events = [
  event(0, "session/start"),
  event(1, "turn/start", { turn: 1 }),
  event(2, "user/message", { source: { kind: "user" }, content: "Hello from the fixture" }),
  event(3, "step/start", { turn: 1, step: 1 }),
  event(4, "step/end", { turn: 1, step: 1 }),
  event(5, "step/start", { turn: 1, step: 2 }),
  event(6, "step/end", { turn: 1, step: 2 }),
  event(7, "turn/end", { turn: 1 })
];

function fixture(rows = events, headerId = sourceId, options = {}) {
  const calls = [];
  const controller = {
    inspect: async () => ({ meta: { id: headerId }, events: rows }),
    fork: async request => { calls.push(request); await options.wait; return { sessionId: childId }; },
    cancel: () => assert.fail("rewind attempted to cancel original session"),
  };
  return { calls, ctx: { get(name) {
    if (name === "sessionController") return controller;
    if (name === "workspaceRegistry") assert.fail("rewind attempted to change original workspace");
    return undefined;
  } } };
}

test("host fork receives exact step and turn boundaries; original events survive", async () => {
  const { calls, ctx } = fixture();
  const before = JSON.stringify(events);
  const step = await applyRewind(ctx, sourceId, "once");
  const round = await applyRewind(ctx, sourceId, "round");
  assert.equal(step.ok, true);
  assert.equal(round.ok, true);
  assert.deepEqual(calls, [4, 0].map(atSeq => ({ sessionId: sourceId, atSeq, allowMigration: false })));
  assert.equal(round.text, "Hello from the fixture");
  assert.equal(JSON.stringify(events), before);
});

test("uncertain session, active replies and ambiguous event indices do not fork", async () => {
  for (const [sid, mode, fixtureArgs] of [
    ["", "round", []],
    [sourceId, "?", []],
    [sourceId, "round", [events, "session-other"]],
    [sourceId, "round", [events.slice(0, -1)]],
    [sourceId, "once", [events.filter(row => row.seq !== 2)]],
  ]) {
    const { calls, ctx } = fixture(...fixtureArgs);
    assert.equal((await applyRewind(ctx, sid, mode)).ok, false);
    assert.deepEqual(calls, []);
  }
});

test("a second click cannot create another fork while the first is pending", async () => {
  let finish;
  const { calls, ctx } = fixture(events, sourceId, { wait: new Promise(r => { finish = r; }) });
  const first = applyRewind(ctx, sourceId, "round");
  const second = await applyRewind(ctx, sourceId, "round");
  assert.equal(second.ok, false);
  finish();
  assert.equal((await first).ok, true);
  assert.equal(calls.length, 1);
});

test("in-place rewind replaces only the last round and restores the original bytes if verification fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dxk-rewind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "fixture.jsonl");
  const rows = [...events,
    event(8, "agent/inbox/spliced", { inserted: [{ id: "question-2" }] }),
    event(9, "turn/start", { turn: 2 }),
    event(10, "user/message", { id: "question-2", source: { kind: "user" }, content: "Second question" }),
    event(11, "assistant/message", { content: "Second answer" }),
    event(12, "turn/end", { turn: 2 }),
  ];
  const original = JSON.stringify(rows);
  fs.writeFileSync(target, original);
  let locked = false;
  let rejectNewLog = true;
  const storage = {
    name: "session-persistence-jsonl", root,
    resolveCurrentLog: async () => target,
    encodeMaterialization: async (_meta, _inherited, prefix) => JSON.stringify(prefix),
    open: async () => {
      assert.equal(locked, false);
      locked = true;
      return { close: async () => { locked = false; } };
    },
    readStoredLog: async () => {
      assert.equal(locked, true);
      const contents = fs.readFileSync(target, "utf8");
      if (rejectNewLog && contents !== original) throw Error("verification refused");
      return { meta: { id: sourceId }, inheritedEventCount: 0, events: JSON.parse(contents) };
    },
  };
  const catalogEvents = [];
  const lifecycleEvents = [];
  const eventService = {
    dispatch(type, args) {
      if (type === "emit" && args[0] === "api-session/removed") catalogEvents.push(args[1]);
      return [];
    },
  };
  const services = { sessionPersistence: storage, sessions: new Map(), agents: new Map() };
  const ctx = { get: key => services[key], events: eventService };
  const loop = {
    prepare(_owner, id) {
      const live = {
        header: { id },
        snapshotEvents: () => JSON.parse(fs.readFileSync(target, "utf8")),
      };
      const agent = {
        session: live, phase: { kind: "idle" },
        inbox: { current: () => ({ "next-turn": [], "next-step": [] }) },
      };
      services.agents.set(id, agent);
      services.sessions.set(id, live);
      return {
        agent, async dispose() {
          services.agents.delete(id);
          services.sessions.delete(id);
          lifecycleEvents.push("dispose");
          eventService.dispatch("emit", ["api-session/removed", id]);
          eventService.dispatch("emit", ["api-session/removed", childId]);
        },
      };
    },
  };
  t.after(captureRewindAgentLifecycle(loop));
  loop.prepare(null, sourceId);
  services.sessionController = {
    async resolveAgent(id) {
      assert.equal(locked, false);
      lifecycleEvents.push("rebind");
      return loop.prepare(null, id);
    },
  };
  assert.match((await applyInplaceRewind(ctx, sourceId)).error, /verification refused/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(locked, false);
  rejectNewLog = false;
  const result = await applyInplaceRewind(ctx, sourceId);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sessionId, sourceId);
  assert.equal(result.text, "Second question");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), events);
  assert.equal(locked, false);
  assert.deepEqual(lifecycleEvents, ["dispose", "rebind", "dispose", "rebind"]);
  assert.deepEqual(catalogEvents, [childId, childId]);
  eventService.dispatch("emit", ["api-session/removed", sourceId]);
  assert.deepEqual(catalogEvents, [childId, childId, sourceId]);
});

test("published frontend refreshes the same session and guards the current draft", async () => {
  const src = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const marker = "module.exports = { name:";
  const fixtureCode = `
    globalThis.api = { __dxkRewind, dxkCompleteRewind, RewindButton };
    globalThis.setHost = (workspace, sessions, conversation) => {
      __dxkWorkspace = workspace;
      __dxkHostSessions = sessions;
      __dxkConversation = conversation;
    };
  `;
  let descriptor;
  const sent = [];
  const drafts = [];
  let selected = sourceId;
  let refreshCount = 0;
  let switchOnCall = false;
  let draft = "";
  let buttonState;
  let nextRef = 0;
  let targetSession = sourceId;
  const refs = [
    { current: { closest: () => ({ getAttribute: () => targetSession }) } },
    { current: null },
    { current: false },
  ];
  const react = {
    useState: initial => {
      buttonState ??= initial;
      return [buttonState, update => { buttonState = update(buttonState); }];
    },
    useRef: () => refs[nextRef++],
    useEffect() {},
    createElement: (type, props, children) => ({ type, props, children }),
  };
  const observedSelections = [];
  let failResync = false;
  let withoutBaseline = false;
  let previousSelection;
  const projections = {
    selection: "before rewind",
    clear() {
      this.selection = undefined;
      queueMicrotask(() => observedSelections.push(this.selection));
    },
  };
  const prototype = {
    installWindow(_entries, _hasMore, baseline) {
      if (baseline) projections.selection = baseline.values.modelSelection;
    },
    async resync() {
      assert.strictEqual(manager.projectionStores.get(sourceId), projections);
      assert.equal(manager.projectionInflight.has(sourceId), false);
      assert.equal(manager.projectionLoads.has(sourceId), false);
      await Promise.resolve();
      assert.equal(projections.selection, previousSelection);
      if (failResync) {
        this.openState = "error";
        return;
      }
      this.openState = "open";
      const value = "rewound model " + (++refreshCount);
      this.installWindow([], false, { asOfSeq: 2, values: withoutBaseline ? {} : { modelSelection: value } });
    },
  };
  const model = Object.assign(Object.create(prototype), {
    projections, removed: false, openState: "open",
  });
  const manager = {
    sessions: new Map([[sourceId, model]]),
    projectionStores: new Map([[sourceId, projections]]),
    projectionInflight: new Map(),
    projectionLoads: new Map(),
  };
  const stale = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { descriptor = value; } } },
    fetch: async (url, opts) => {
      if (url.includes("/diag?")) return { json: async () => ({ ok: true, summary: "fixture" }) };
      sent.push(JSON.parse(opts.body));
      if (switchOnCall) selected = "session-other";
      const request = new AbortController();
      stale.push(request);
      manager.projectionLoads.set(sourceId, { state: "ready" });
      manager.projectionInflight.set(sourceId, { controller: request });
      manager.listInflight = Promise.resolve().then(() => {
        // A catalog response begun before the rewind can contain a newer cursor.
        previousSelection = projections.selection = "stale model";
        manager.projectionStores.set(sourceId, {});
      });
      model.removed = true;
      return { ok: true, json: async () => ({
        ok: true, sessionId: sourceId, mode: "inplace", text: "Hello", refresh: true,
      }) };
    },
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(src.replace(marker, fixtureCode + marker), sandbox);
  descriptor.factory(() => react);
  sandbox.setHost({
    selection: { getSnapshot: () => ({ sessionId: selected }) },
    openSession: () => assert.fail("rewind navigated away"),
  }, { manager }, {
    input: { shell: id => ({
      snapshot: { draft },
      setDraft: text => { drafts.push([id, text]); },
    }) },
  });
  assert.equal((await sandbox.api.__dxkRewind("")).ok, false);
  assert.deepEqual(sent, []);
  const first = sandbox.api.dxkCompleteRewind(sourceId);
  assert.strictEqual(sandbox.api.dxkCompleteRewind(sourceId), first);
  assert.match(await first, /当前对话回退上一轮/);
  assert.equal(projections.selection, "rewound model 1");
  assert.equal(model.removed, false);
  assert.equal(selected, sourceId);
  assert.deepEqual(sent, [{ sessionId: sourceId, mode: "inplace-round" }]);
  assert.deepEqual(drafts, [[sourceId, "Hello"]]);
  draft = "Unsent draft";
  await sandbox.api.dxkCompleteRewind(sourceId);
  assert.equal(projections.selection, "rewound model 2");
  assert.equal(model.removed, false);
  assert.ok(stale.every(request => request.signal.aborted));
  assert.deepEqual(observedSelections, ["rewound model 1", "rewound model 2"]);
  assert.equal(Object.hasOwn(model, "installWindow"), false);
  switchOnCall = true;
  await sandbox.api.dxkCompleteRewind(sourceId);
  assert.equal(selected, "session-other");
  assert.equal(refreshCount, 3);
  assert.deepEqual(drafts, [[sourceId, "Hello"]]);

  selected = sourceId;
  switchOnCall = false;
  withoutBaseline = true;
  await sandbox.api.dxkCompleteRewind(sourceId);
  assert.equal(projections.selection, "stale model");
  assert.equal(observedSelections.length, 3);
  withoutBaseline = false;
  failResync = true;
  assert.match(await sandbox.api.dxkCompleteRewind(sourceId), /回退已保存/);
  assert.equal(projections.selection, "stale model");
  assert.equal(Object.hasOwn(model, "installWindow"), false);
  failResync = false;

  // Exercise the actual toolbar callbacks, including a menu left open during a session switch.
  selected = sourceId;
  switchOnCall = false;
  function toolbar() {
    nextRef = 0;
    return sandbox.api.RewindButton({}).children;
  }
  const click = { preventDefault() {} };
  toolbar()[0].props.onClick(click);
  let choices = toolbar()[1].children.filter(node => node?.type === "button");
  assert.equal(choices.length, 1);
  choices[0].props.onClick(click);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { sessionId: sourceId, mode: "inplace-round" });
  const requestCount = sent.length;
  toolbar()[0].props.onClick(click);
  choices = toolbar()[1].children.filter(node => node?.type === "button");
  targetSession = childId;
  choices[0].props.onClick(click);
  assert.equal(sent.length, requestCount);
});
