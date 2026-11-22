import { lockSessionMutation, releaseSessionBeforeRecycle } from "./rewind.js";

export async function archiveAndRecycle(ctx, sessionId, move) {
  const registry = ctx?.get?.("workspaceRegistry");
  if (typeof registry?.archiveSession !== "function" ||
      typeof registry?.unarchiveSession !== "function" ||
      !Array.isArray(registry.archivedSessionIds)) {
    return { ok: false, error: "DSH 工作区服务尚未就绪，请稍后重试。" };
  }
  const unlock = lockSessionMutation(sessionId, "recycle");
  if (!unlock) return { ok: false, error: "该对话正在回退或删除，请稍候。" };
  try {
    const wasArchived = registry.archivedSessionIds.includes(sessionId);
    const wasPinned = registry.pinnedSessionIds?.includes(sessionId);
    // 由宿主发布列表变更。正在执行任务的会话由宿主拒绝归档。
    if (!wasArchived) await registry.archiveSession(sessionId);
    try {
      await releaseSessionBeforeRecycle(ctx, sessionId);
      await move();
      return { ok: true };
    } catch (error) {
      if (!wasArchived) {
        try {
          await registry.unarchiveSession(sessionId);
          if (wasPinned) await registry.pinSession(sessionId);
        } catch (restoreError) {
          return { ok: false, refresh: true, error: "移入回收站失败，侧栏状态也未能自动恢复：" + restoreError.message };
        }
      }
      return { ok: false, refresh: true, error: "移入回收站失败：" + error.message };
    }
  } catch (error) {
    return { ok: false, error: "DSH 无法隐藏该对话：" + error.message };
  } finally {
    unlock();
  }
}
