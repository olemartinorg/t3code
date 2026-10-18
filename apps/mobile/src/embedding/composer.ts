/** Optional host access to native drafts. Standalone persistence remains unchanged. */
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { appAtomRegistry } from "../state/atom-registry";
import { composerDraftsAtom, schedulePersistComposerState } from "../state/use-composer-drafts";
export {
  waitForComposerDraftsLoaded,
  flushComposerDrafts,
  createNewTaskDraft,
} from "../state/use-composer-drafts";
export type { ComposerDraft } from "../state/use-composer-drafts";
export const readComposerDrafts = () => appAtomRegistry.get(composerDraftsAtom);
export const observeComposerDrafts = (
  listener: (drafts: ReturnType<typeof readComposerDrafts>) => void,
) => appAtomRegistry.subscribe(composerDraftsAtom, listener);
export function applyComposerDraftTexts(
  updates: ReadonlyArray<{
    key: string;
    text: string;
    project?: { environmentId: string; projectId: string; createdAt: string };
  }>,
): void {
  const next = { ...readComposerDrafts() };
  let changed = false;
  for (const update of updates) {
    const current = next[update.key];
    if (!current && !update.text) continue;
    if (
      current?.text === update.text &&
      (!update.project || JSON.stringify(current.project) === JSON.stringify(update.project))
    )
      continue;
    changed = true;
    next[update.key] = {
      ...current,
      text: update.text,
      attachments: current?.attachments ?? [],
      ...(update.project
        ? {
            project: {
              ...update.project,
              environmentId: EnvironmentId.make(update.project.environmentId),
              projectId: ProjectId.make(update.project.projectId),
            },
          }
        : {}),
    };
  }
  if (!changed) return;
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerState();
}
