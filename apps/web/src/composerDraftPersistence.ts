/** Native persistence metadata and content projection; importing this does not initialize stores. */
export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
const contentFields = [
  "attachments",
  "files",
  "terminalContexts",
  "previewAnnotations",
  "reviewComments",
  "threadContexts",
] as const;

function draftContent(value: unknown) {
  const draft = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    prompt: typeof draft.prompt === "string" ? draft.prompt : "",
    ...(Object.fromEntries(
      contentFields.map((field) => [field, Array.isArray(draft[field]) ? draft[field] : []]),
    ) as Record<(typeof contentFields)[number], unknown[]>),
  };
}
export function persistedComposerDraftHasUserContent(value: unknown): boolean {
  const content = draftContent(value);
  return (
    content.prompt.trim().length > 0 || contentFields.some((field) => content[field].length > 0)
  );
}
/** Ignore empty hydration metadata and model defaults when comparing unsent content. */
export function projectPersistedComposerContent(value: unknown) {
  const drafts =
    (value as { state?: { draftsByThreadKey?: Record<string, unknown> } } | null)?.state
      ?.draftsByThreadKey ?? {};
  return Object.keys(drafts)
    .sort()
    .flatMap((key) =>
      persistedComposerDraftHasUserContent(drafts[key])
        ? [{ key, ...draftContent(drafts[key]) }]
        : [],
    );
}
