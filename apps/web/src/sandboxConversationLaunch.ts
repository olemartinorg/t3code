import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "./composerDraftStore";

export function hasNewThreadDraftContent(state: ReturnType<typeof useComposerDraftStore.getState>): boolean {
  return contentBearingNewThreadDraftId(state) !== null;
}

export function soleOpenConversation(
  threads: readonly EnvironmentThreadShell[], environmentId: EnvironmentId | null,
): EnvironmentThreadShell | null {
  if (environmentId === null) return null;
  const open = threads.filter(thread => thread.environmentId === environmentId &&
    thread.archivedAt === null && thread.settledOverride !== "settled");
  return open.length === 1 ? open[0]! : null;
}

export function shouldCloseInitialSidebar(pathname: string, sole: EnvironmentThreadShell | null, hasDraft: boolean): boolean {
  return sole !== null && !hasDraft &&
    (pathname === "/" || pathname === `/${encodeURIComponent(sole.environmentId)}/${encodeURIComponent(sole.id)}`);
}

export function contentBearingNewThreadDraftId(state: ReturnType<typeof useComposerDraftStore.getState>): DraftId | null {
  const entries = Object.entries(state.draftThreadsByThreadKey).filter(([key, session]) =>
    session.promotedTo == null && composerDraftHasUserContent(state.draftsByThreadKey[key]),
  );
  entries.sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt) || a[0].localeCompare(b[0]));
  return entries[0] ? DraftId.make(entries[0][0]) : null;
}
