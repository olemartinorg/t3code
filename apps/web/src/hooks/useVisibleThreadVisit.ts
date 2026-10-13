import { useEffect, useRef } from "react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useSandboxPaneVisible } from "../sandboxEmbedding";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadLastVisitedAt } from "../components/Sidebar.logic";

const VISIT_DISPATCH_THROTTLE_MS = 10_000;

export function useVisibleThreadVisit(serverThread: EnvironmentThreadShell | null, routeThreadKey: string) {
  const sandboxPaneVisible = useSandboxPaneVisible();
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore(store => store.markThreadVisited);
  const activeThreadLocalLastVisitedAt = useUiStateStore(store => store.threadLastVisitedAtById[routeThreadKey]);
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchAtRef = useRef(0);
  useEffect(() => {
    if (!sandboxPaneVisible) {
      lastDispatchedVisitRef.current = null;
      lastVisitDispatchAtRef.current = 0;
      return;
    }
    if (!serverThread?.id) return;
    // Imported V1 completions can be later than the thread metadata timestamp.
    // Seeing that transcript must acknowledge its actual completion watermark.
    const completedAt = serverThread.lastCompletionAt ? Date.parse(serverThread.lastCompletionAt) : NaN;
    const threadUpdatedAt = Math.max(Date.parse(serverThread.updatedAt), Number.isNaN(completedAt) ? 0 : completedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const visitedAt = new Date(threadUpdatedAt).toISOString();
    const effectiveLastVisitedAt = resolveThreadLastVisitedAt(
      serverThread.lastVisitedAt,
      activeThreadLocalLastVisitedAt,
    );
    const lastVisitedAt = effectiveLastVisitedAt ? Date.parse(effectiveLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    if (serverThread.lastVisitedAt !== undefined) {
      // Server-tracked visited state: record the watermark server-side so it
      // syncs across every device connected to the environment. Dedupe per
      // watermark — the effect re-runs before the command's echo lands. The
      // dedupe also keeps a mark-unread on the open thread sticky: the rewind
      // leaves updatedAt untouched, so the already-dispatched key skips a
      // fresh visit until new activity lands or the thread is reopened.
      const dispatchKey = `${routeThreadKey}:${visitedAt}`;
      if (lastDispatchedVisitRef.current === dispatchKey) return;
      const dispatch = () => {
        lastDispatchedVisitRef.current = dispatchKey;
        lastVisitDispatchAtRef.current = Date.now();
        void visitThreadMutation({
          environmentId: serverThread.environmentId,
          input: { threadId: serverThread.id, visitedAt },
        });
      };
      // Unread prominence only flips on run completions (hasUnseenCompletion),
      // so an unseen completion publishes immediately; mid-turn activity bumps
      // — several per second while a turn streams — ride a trailing throttle,
      // each rerun swapping the timer so the trailing dispatch carries the
      // newest watermark.
      const latestRunCompletedAtMs = serverThread.lastCompletionAt
        ? Date.parse(serverThread.lastCompletionAt)
        : NaN;
      const hasUnseenCompletion =
        !Number.isNaN(latestRunCompletedAtMs) &&
        (Number.isNaN(lastVisitedAt) || latestRunCompletedAtMs > lastVisitedAt);
      const elapsed = Date.now() - lastVisitDispatchAtRef.current;
      if (hasUnseenCompletion || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
        dispatch();
        return;
      }
      const timer = setTimeout(dispatch, VISIT_DISPATCH_THROTTLE_MS - elapsed);
      return () => clearTimeout(timer);
    }

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      visitedAt,
    );
  }, [
    activeThreadLocalLastVisitedAt,
    markThreadVisited,
    routeThreadKey,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.lastVisitedAt,
    serverThread?.lastCompletionAt,
    serverThread?.updatedAt,
    sandboxPaneVisible,
    visitThreadMutation,
  ]);
}
