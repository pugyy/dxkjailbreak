// Rewind conversation history through the DSH session controller.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const DRAFT_TTL_MS = 10 * 60 * 1000;
const pendingDrafts = new Map();
const agentDisposers = new WeakMap();
const sessionMutations = new Map();
const catalogDispatchers = new WeakMap();

export function lockSessionMutation(sessionId, operation) {
  if (sessionMutations.has(sessionId)) return null;
  sessionMutations.set(sessionId, operation);
  return () => sessionMutations.delete(sessionId);
}

// DSH returns the ordered session/agent teardown with the prepared agent.
// Retain that capability for the exact live instance.
export function captureRewindAgentLifecycle(loop) {
  const prepare = loop?.prepare;
  if (typeof prepare !== "function") return;
  function capture(...args) {
    if (sessionMutations.get(args[1]) === "recycle") throw new Error("该会话正在移入回收站。");
    const prepared = prepare.apply(this, args);
    if (prepared?.agent && typeof prepared.dispose === "function") {
      agentDisposers.set(prepared.agent, prepared.dispose);
    }
    return prepared;
  }
  loop.prepare = capture;
  return () => {
    if (loop.prepare === capture) loop.prepare = prepare;
  };
}

function errorText(err) {
  if (!err) return "Undo failed";
  if (typeof err === "string") return err;
  return err.message || err.code || String(err);
}

/**
 * DSH releases the old live instance during an in-place rewind. Its catalog
 * removal event would mark the still-open editor as permanently deleted.
 * Keep every other lifecycle event, including actual session deletion.
 */
async function disposeForRewind(ctx, sessionId, dispose) {
  const events = ctx.events;
  const original = events?.dispatch;
  if (typeof original !== "function") return dispose();
  let filter = catalogDispatchers.get(original);
  if (!filter) {
    const ids = new Set();
    events.dispatch = function (type, args) {
      const scoped = typeof args[0] === "object" || typeof args[0] === "function";
      const index = scoped ? 1 : 0;
      if (type === "emit" && args[index] === "api-session/removed" && ids.has(args[index + 1])) return [];
      return original.call(this, type, args);
    };
    const installed = events.dispatch;
    filter = { ids, restore() {
      if (events.dispatch === installed) events.dispatch = original;
      catalogDispatchers.delete(installed);
    } };
    catalogDispatchers.set(installed, filter);
  }
  filter.ids.add(sessionId);
  try { await dispose(); }
  finally {
    filter.ids.delete(sessionId);
    if (filter.ids.size === 0) filter.restore();
  }
}

function asEventList(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events[Symbol.iterator] === "function") {
    try {
      return [...events];
    } catch {
      return [];
    }
  }
  return [];
}

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function userTextFromEvent(event) {
  const data = event?.data;
  const content = data?.content ?? data?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" || typeof block.text === "string") {
      parts.push(String(block.text ?? ""));
    }
  }
  return parts.join("").trim();
}

function isPluginDraft(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /^\[MNEMON\]/i.test(value)
    || /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
    || /^MNEMON VIEW TOOLS/im.test(value);
}

function isRewindMarkerEvent(event) {
  if (!event || event.type !== "user/message") return false;
  const id = event.data?.id;
  return typeof id === "string" && id.startsWith("rewind-");
}

function isHumanUserEvent(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  if (source?.kind === "plugin") return false;
  if (source?.kind && source.kind !== "user") return false;
  const text = userTextFromEvent(event);
  if (!text || isPluginDraft(text)) return false;
  return true;
}

/** 这一轮真正发出去的那句。手打是 user；goal 各轮也算（含 round 0 的首轮 goal）。 */
function isRoundPromptEvent(event) {
  if (!event || event.type !== "user/message" || isRewindMarkerEvent(event)) return false;
  const source = event.data?.source;
  const kind = source?.kind;
  if (kind === "plugin") return false;
  const text = userTextFromEvent(event);
  if (!text || isPluginDraft(text)) return false;
  if (!kind || kind === "user") return true;
  if (kind === "goal") return Number.isFinite(Number(source.round)) && Number(source.round) >= 0;
  return false;
}

/** 最近一轮已经 turn/end 的边界。用 turn 窗口找提示，避免第二轮完成却退回第一句。 */
function eventsInOrder(events) {
  return asEventList(events)
    .map((event, index) => ({ event, seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : index }))
    .sort((left, right) => left.seq - right.seq);
}

function lastOpenTurn(events) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const type = list[i]?.type;
    if (type === "turn/start") return list[i];
    if (type === "turn/end") return null;
  }
  return null;
}

function isSubagentHeader(header) {
  if (!header) return false;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

export function pendingInboxInserts(events) {
  const list = Array.isArray(events) ? events : [];
  let lastEnd = -1;
  let lastStart = -1;
  for (const event of list) {
    if (event?.type === "turn/end") lastEnd = event.seq;
    if (event?.type === "turn/start") lastStart = event.seq;
  }
  const after = lastEnd >= 0 ? lastEnd : -1;
  const ids = [];
  const seen = new Set();
  for (const event of list) {
    if (!event || event.seq <= after) continue;
    if (lastStart > after && event.seq >= lastStart) continue;
    if (event.type !== "agent/inbox/spliced") continue;
    if (event.data?.target && event.data.target !== "next-turn") continue;
    for (const message of event.data?.inserted || []) {
      const id = message?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function lastTurnSubagentIds(events, fromSeq = -1) {
  const list = Array.isArray(events) ? events : [];
  let floor = Number(fromSeq);
  if (!Number.isFinite(floor) || floor < 0) {
    floor = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === "turn/start") {
        floor = list[i].seq;
        break;
      }
    }
  }
  if (floor < 0) return [];
  const ids = [];
  const seen = new Set();
  for (const event of list) {
    if (!event || event.seq < floor) continue;
    if (event.type !== "subagent/catalog" && event.type !== "subagent/descriptor") continue;
    const id = event.data?.childId || event.data?.sessionId || event.data?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function seqBefore(events, cutSeq) {
  const floor = Number(cutSeq);
  let prev = null;
  for (const row of eventsInOrder(events)) {
    if (!Number.isFinite(row.seq)) continue;
    if (Number.isFinite(floor) && row.seq >= floor) break;
    prev = row;
  }
  return prev && Number.isFinite(prev.seq) ? prev.seq : null;
}

function lastEventOfType(events, type) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === type) return list[i];
  }
  return null;
}

function userTextFromRange(events, fromSeq) {
  const list = asEventList(events);
  const floor = Number(fromSeq);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    const seq = Number(event?.seq);
    if (Number.isFinite(floor) && Number.isFinite(seq) && seq < floor) break;
    if (isRoundPromptEvent(event)) return userTextFromEvent(event);
  }
  return "";
}

function isFirstStepOfTurn(events, start) {
  if (!start) return true;
  const turn = start.data?.turn;
  const startSeq = Number(start.seq);
  return !asEventList(events).some((event) => (
    event?.type === "step/start"
    && event !== start
    && Number(event.seq) < startSeq
    && (turn == null || event.data?.turn === turn)
  ));
}

function turnStartFor(events, turn, beforeSeq) {
  const limit = Number(beforeSeq);
  let found = null;
  for (const event of asEventList(events)) {
    const seq = Number(event?.seq);
    if (Number.isFinite(limit) && Number.isFinite(seq) && seq > limit) break;
    if (event?.type === "turn/start" && (turn == null || event.data?.turn === turn)) found = event;
  }
  return found;
}

/** once = 撤最后一步；round = 撤最后一整轮。fork 的 atSeq 含这一条，之后的消息都不要。 */
export function planRewind(events, mode = "once") {
  return mode === "round" ? planRewindTurn(events) : planRewindStep(events);
}

function planRewindStep(events) {
  const start = lastEventOfType(events, "step/start");
  if (!start) return planRewindTurn(events);
  const turn = start.data?.turn;
  const step = start.data?.step;
  let cutSeq = Number(start.seq);
  if (isFirstStepOfTurn(events, start)) {
    const turnStart = turnStartFor(events, turn, start.seq);
    if (turnStart && Number.isFinite(Number(turnStart.seq))) cutSeq = Number(turnStart.seq);
  }
  const text = userTextFromRange(events, cutSeq);
  const atSeq = seqBefore(events, cutSeq);
  if (atSeq == null) {
    if (!text) return { ok: false, error: "Nothing to undo" };
    return { ok: true, mode: "blank", text, unit: "step", turn, step, fromSeq: cutSeq };
  }
  return { ok: true, mode: "fork", atSeq, text, unit: "step", turn, step, fromSeq: cutSeq };
}

function planRewindTurn(events) {
  const list = asEventList(events);
  const open = lastOpenTurn(list);
  let turnStart = open;
  if (!turnStart) {
    const ended = lastEventOfType(list, "turn/end");
    if (ended) turnStart = turnStartFor(list, ended.data?.turn, ended.seq) || ended;
  }
  if (!turnStart) {
    const lastUser = [...list].reverse().find((event) => isRoundPromptEvent(event));
    if (!lastUser) return { ok: false, error: "Nothing to undo" };
    const cutSeq = Number(lastUser.seq);
    const text = userTextFromEvent(lastUser);
    const atSeq = seqBefore(list, cutSeq);
    if (atSeq == null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
    return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
  }
  const cutSeq = Number(turnStart.seq);
  const text = userTextFromRange(list, cutSeq);
  const atSeq = seqBefore(list, cutSeq);
  if (!text && atSeq == null) return { ok: false, error: "Nothing to undo" };
  if (atSeq == null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
  return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
}

function rememberDraft(sessionId, text, parentId) {
  const rec = {
    sessionId,
    parentId,
    text: text || "",
    at: Date.now(),
  };
  pendingDrafts.set(sessionId, rec);
  const now = Date.now();
  for (const [id, row] of pendingDrafts) {
    if (now - row.at > DRAFT_TTL_MS) pendingDrafts.delete(id);
  }
  return rec;
}

export function getDraft(sessionId) {
  if (!sessionId) return null;
  const rec = pendingDrafts.get(sessionId);
  if (!rec) return null;
  if (Date.now() - rec.at > DRAFT_TTL_MS) {
    pendingDrafts.delete(sessionId);
    return null;
  }
  return rec;
}

export function takeDraft(sessionId) {
  const rec = getDraft(sessionId);
  if (rec) pendingDrafts.delete(sessionId);
  return rec;
}

export function lastHumanUserText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isHumanUserEvent(list[i])) return userTextFromEvent(list[i]);
  }
  return "";
}

export async function readLastUserText(ctx, sessionId) {
  if (!sessionId) return { ok: false, text: "", error: "No active session" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    return { ok: true, text: lastHumanUserText(log.events) };
  } catch (err) {
    return { ok: false, text: "", error: errorText(err) };
  }
}

function disposeObservation(observed) {
  try {
    observed?.[Symbol.dispose]?.();
  } catch {
    /* ignore */
  }
}

async function readSessionLog(ctx, sessionId) {
  const store = service(ctx, "sessions");
  const live = store?.get?.(sessionId);
  if (live?.snapshotEvents) {
    return {
      events: asEventList(live.snapshotEvents()),
      header: live.header,
      cwd: live.header?.cwd,
    };
  }

  const controller = service(ctx, "sessionController");
  if (typeof controller?.inspect === "function") {
    const inspected = await controller.inspect(sessionId);
    return {
      events: asEventList(inspected?.events),
      header: inspected?.meta || inspected?.header,
      cwd: inspected?.meta?.cwd || inspected?.header?.cwd,
    };
  }

  const query = service(ctx, "sessionQuery");
  if (typeof query?.observeSession === "function") {
    const observed = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      return {
        events: asEventList(observed?.events),
        header: observed?.header,
        cwd: observed?.header?.cwd,
      };
    } finally {
      disposeObservation(observed);
    }
  }

  throw new Error("Cannot find the current session");
}

/** Resolve the exact idle agent and its ordered DSH teardown. */
function idleSessionLifecycle(ctx, sessionId) {
  const sessions = service(ctx, "sessions");
  const agents = service(ctx, "agents");
  if (typeof sessions?.get !== "function" || typeof agents?.get !== "function") {
    throw new Error("DSH 会话服务尚未就绪，请稍后重试。");
  }
  const live = sessions.get(sessionId);
  const agent = agents.get(sessionId);
  if (!live && !agent) return null;
  const dispose = agent && agentDisposers.get(agent);
  if (!dispose || agent.session !== live || live?.header?.id !== sessionId) {
    throw new Error("无法安全释放当前会话，请完整重启 DSH 后再试。");
  }
  if (agent.phase?.kind !== "idle") throw new Error("会话正在处理消息，请稍后重试。");
  const inbox = agent.inbox.current();
  if (inbox["next-turn"].length || inbox["next-step"].length) {
    throw new Error("请先处理会话里排队的消息。");
  }
  return { live, dispose };
}

export async function releaseSessionBeforeRecycle(ctx, sessionId) {
  const lifecycle = idleSessionLifecycle(ctx, sessionId);
  if (!lifecycle) return;
  await lifecycle.dispose();
  if (service(ctx, "sessions").get(sessionId) || service(ctx, "agents").get(sessionId)) {
    throw new Error("DSH 仍持有该会话，会话文件已保留。");
  }
}

export function isRewindSessionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

export async function analyzeRewind(ctx, sessionId) {
  if (!sessionId) return { ok: false, error: "No active session" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    const kind = isSubagentHeader(log.header) ? "subagent" : "main";
    const subagentIds = kind === "main" ? lastTurnSubagentIds(log.events) : [];
    return {
      ok: true,
      kind,
      sessionId,
      hasSubagents: subagentIds.length > 0,
      subagentIds,
    };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function applyRewind(ctx, sessionId, mode) {
  if (!isRewindSessionId(sessionId)) return { ok: false, error: "需要明确指定当前会话。" };
  if (mode !== "once" && mode !== "round") return { ok: false, error: "未知的回退方式。" };
  const controller = service(ctx, "sessionController");
  if (typeof controller?.fork !== "function") return { ok: false, error: "当前 DSH 不提供会话分叉接口。" };
  const unlock = lockSessionMutation(sessionId, "rewind");
  if (!unlock) return { ok: false, error: "该会话正在回退或删除，请稍候。" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    if (log.header?.id !== sessionId) return { ok: false, error: "宿主返回的会话与当前会话不一致。" };
    if (lastOpenTurn(log.events)) return { ok: false, error: "当前回复仍在进行，请等它结束或手动停止后再回退。" };
    const plan = planRewind(log.events, mode);
    if (!plan.ok) return plan;
    if (plan.mode !== "fork") return { ok: false, error: "已到会话开头，没有更早的历史可分叉。" };
    if (!Number.isSafeInteger(plan.atSeq) || plan.atSeq < 0 || log.events[plan.atSeq]?.seq !== plan.atSeq) {
      return { ok: false, error: "无法确认准确的回退位置，原会话已保留。" };
    }

    const created = await controller.fork({ sessionId, atSeq: plan.atSeq, allowMigration: false });
    const childId = typeof created === "string" ? created : created?.sessionId;
    if (!isRewindSessionId(childId) || childId === sessionId) {
      return { ok: false, error: "宿主未返回有效的回退分支。" };
    }
    const { text, at } = rememberDraft(childId, plan.text, sessionId);
    return { ok: true, mode: "fork", sessionId: childId, parentId: sessionId, text, cut: plan.unit, at };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    unlock();
  }
}

function planInplaceRound(events) {
  if (events.some((event, index) => event?.seq !== index)) {
    throw new Error("会话记录的顺序无法确认。");
  }
  if (lastOpenTurn(events)) throw new Error("当前回复仍在进行，请等它结束后再回退。");
  const end = lastEventOfType(events, "turn/end");
  const start = end && turnStartFor(events, end.data?.turn, end.seq);
  if (!start || start.seq >= end.seq) throw new Error("没有可回退的完整一轮。");
  if (events.slice(end.seq + 1).some(event => isRoundPromptEvent(event)
      || (event.type === "agent/inbox/spliced" && event.data?.inserted?.length))) {
    throw new Error("上一轮后还有新消息，请先处理这些消息。");
  }
  const prompts = events.slice(start.seq + 1, end.seq).filter((event) => {
    if (isRoundPromptEvent(event)) return true;
    return event.type === "user/message" && event.data?.source?.kind === "user"
      && !isRewindMarkerEvent(event) && !userTextFromEvent(event) && event.data?.content?.length > 0;
  });
  if (prompts.length === 0) throw new Error("找不到这一轮对应的提问，会话已保留。");
  const ids = new Set(prompts.map(event => event.data?.id).filter(Boolean));
  const previousEnd = lastEventOfType(events.slice(0, start.seq), "turn/end")?.seq ?? -1;
  let cut = start.seq;
  for (const event of events.slice(0, start.seq)) {
    if (event.type !== "agent/inbox/spliced") continue;
    const inserted = event.data?.inserted ?? [];
    if (!inserted.some(message => ids.has(message.id))) continue;
    if (event.seq <= previousEnd || inserted.some(message => !ids.has(message.id))
        || (event.data?.removedCount ?? 0) > 0) {
      throw new Error("这一轮与较早的排队消息交叠，无法安全分开，会话已保留。");
    }
    cut = Math.min(cut, event.seq);
  }
  return { cut, text: userTextFromEvent(prompts[0]) };
}

async function writeDurably(file, contents) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceRoundLog(storage, target, sessionId, meta, inheritedEventCount, prefix) {
  const root = await realpath(storage.root);
  const physical = await realpath(target);
  const location = relative(root, physical);
  if (!location || isAbsolute(location) || location === ".." || location.startsWith(".." + sep)
      || !(await lstat(target)).isFile()) {
    throw new Error("宿主会话日志位置异常，会话已保留。");
  }
  const contents = await storage.encodeMaterialization(meta, inheritedEventCount, prefix);
  const suffix = Date.now() + "-" + randomUUID();
  const backup = physical + ".dxk-rewind-bak-" + suffix;
  const stage = physical + ".dxk-rewind-tmp-" + suffix;
  let replaced = false;
  try {
    await writeDurably(stage, contents);
    await copyFile(physical, backup, constants.COPYFILE_EXCL);
    const saved = await open(backup, "r+");
    try { await saved.sync(); } finally { await saved.close(); }
    await rename(stage, physical);
    replaced = true;
    const verified = await storage.readStoredLog(physical, sessionId);
    if (verified.meta?.id !== sessionId || !isDeepStrictEqual(verified.events, prefix)
        || verified.tornTruncateTo !== undefined || verified.recoveredTail?.length) {
      throw new Error("宿主复核回退结果失败。");
    }
  } catch (error) {
    if (replaced) {
      try {
        await copyFile(backup, stage, constants.COPYFILE_EXCL);
        await rename(stage, physical);
      } catch (restoreError) {
        throw new Error("恢复日志失败，完整备份位于 " + backup + "。 " + errorText(restoreError));
      }
    }
    throw error;
  } finally {
    await unlink(stage).catch(() => {});
  }
}

export async function applyInplaceRewind(ctx, sessionId) {
  if (!isRewindSessionId(sessionId)) return { ok: false, error: "需要明确指定当前会话。" };
  const storage = service(ctx, "sessionPersistence");
  const sessions = service(ctx, "sessions");
  const agents = service(ctx, "agents");
  if (storage?.name !== "session-persistence-jsonl" || typeof storage.resolveCurrentLog !== "function"
      || typeof storage.encodeMaterialization !== "function" || typeof storage.readStoredLog !== "function"
      || typeof storage.open !== "function" || typeof sessions?.get !== "function"
      || typeof agents?.get !== "function") {
    return { ok: false, error: "当前 DSH 的会话存储接口不支持原地回退。" };
  }

  const unlock = lockSessionMutation(sessionId, "rewind");
  if (!unlock) return { ok: false, error: "该会话正在回退或删除，请稍候。" };
  let writer;
  let releasedLive = false;
  let result;
  try {
    const target = await storage.resolveCurrentLog(sessionId);
    if (!target) throw new Error("没有可回退的当前版会话日志。");
    const lifecycle = idleSessionLifecycle(ctx, sessionId);
    let snapshot;
    if (lifecycle) {
      if (isSubagentHeader(lifecycle.live.header)) {
        throw new Error("无法确认当前主会话。");
      }
      snapshot = asEventList(lifecycle.live.snapshotEvents());
      planInplaceRound(snapshot);
      releasedLive = true;
      await disposeForRewind(ctx, sessionId, lifecycle.dispose);
    }
    writer = await storage.open(sessionId, "write");
    if (sessions.get(sessionId) || agents.get(sessionId)) throw new Error("会话刚刚重新加载，请再试一次。");
    if (await storage.resolveCurrentLog(sessionId) !== target) throw new Error("会话日志位置已变更。");
    const stored = await storage.readStoredLog(target, sessionId);
    if (stored.meta?.id !== sessionId || isSubagentHeader(stored.meta)
        || stored.tornTruncateTo !== undefined || stored.recoveredTail?.length) {
      throw new Error("无法确认当前会话日志完整，会话已保留。");
    }
    if (snapshot && !isDeepStrictEqual(snapshot, stored.events)) {
      throw new Error("会话在回退期间有新变化，请再试一次。");
    }
    const { cut, text } = planInplaceRound(stored.events);
    await replaceRoundLog(storage, target, sessionId, stored.meta, Math.min(stored.inheritedEventCount, cut), stored.events.slice(0, cut));
    result = { ok: true, mode: "inplace", sessionId, text, refresh: true };
  } catch (error) {
    result = { ok: false, error: errorText(error), sessionId, refresh: releasedLive };
  } finally {
    try {
      await writer?.close();
      const controller = service(ctx, "sessionController");
      if (result?.refresh && typeof controller?.resolveAgent === "function") {
        const reopened = await controller.resolveAgent(sessionId);
        if (reopened?.agent?.session?.header?.id !== sessionId) {
          throw new Error(errorText(reopened?.error || "宿主未重新绑定原会话。"));
        }
      }
    } catch (error) {
      if (result?.refresh) result.rebindError = errorText(error);
      ctx.logger?.warn?.("回退后重新绑定会话失败：" + errorText(error));
    }
    finally { unlock(); }
  }
  return result;
}
