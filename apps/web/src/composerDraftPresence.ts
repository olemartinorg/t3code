import type {
  ComposerDraftPresenceEntry,
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { composerDraftHasUserContent, type DraftThreadState } from "./composerDraftStore";

/** Select only destinations and presence, including drafts outside the mounted route. */
export function composerDraftPresenceEntries(
  state: {
    readonly draftsByThreadKey: Readonly<
      Record<string, Parameters<typeof composerDraftHasUserContent>[0]>
    >;
    readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
    readonly backgroundSubmissionThreadKeys: Readonly<Record<string, true>>;
  },
  environmentId: EnvironmentId,
  shell: {
    readonly projects: readonly Pick<OrchestrationV2ShellSnapshot["projects"][number], "id">[];
    readonly threads: readonly Pick<
      OrchestrationV2ShellSnapshot["threads"][number],
      "id" | "projectId" | "deletedAt" | "archivedAt" | "settledAt" | "settledOverride" | "lineage"
    >[];
  },
): ComposerDraftPresenceEntry[] {
  const projects = new Set(shell.projects.map((project) => project.id));
  const threads = new Map(shell.threads.map((thread) => [thread.id, thread]));
  const entries: ComposerDraftPresenceEntry[] = [];
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    if (!composerDraftHasUserContent(draft) || state.backgroundSubmissionThreadKeys[key]) continue;
    const session = state.draftThreadsByThreadKey[key];
    if (session) {
      if (
        session.environmentId !== environmentId ||
        !projects.has(session.projectId) ||
        session.promotedTo ||
        state.backgroundSubmissionThreadKeys[
          scopedThreadKey({ environmentId, threadId: session.threadId })
        ]
      )
        continue;
      entries.push({ projectId: session.projectId, draftId: key });
      continue;
    }
    const ref = parseScopedThreadKey(key);
    if (!ref || ref.environmentId !== environmentId) continue;
    const thread = threads.get(ref.threadId);
    if (
      !thread ||
      !projects.has(thread.projectId) ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.settledAt !== null ||
      thread.settledOverride === "settled" ||
      thread.lineage.relationshipToParent === "subagent"
    )
      continue;
    entries.push({ projectId: thread.projectId, threadId: thread.id });
  }
  return entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
