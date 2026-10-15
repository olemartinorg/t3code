import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const SourceIdentity = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
const DraftIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** Content identities only. The owning client retains the editable document. */
export const ComposerDraftPresenceEntry = Schema.Union([
  Schema.Struct({ projectId: ProjectId, threadId: ThreadId }),
  Schema.Struct({ projectId: ProjectId, draftId: DraftIdentity }),
]);
export type ComposerDraftPresenceEntry = typeof ComposerDraftPresenceEntry.Type;

export const ComposerDraftPresence = Schema.Struct({
  environmentId: EnvironmentId,
  revision: NonNegativeInt,
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      threadIds: Schema.Array(ThreadId),
      hasProjectDraft: Schema.Boolean,
    }),
  ),
});
export type ComposerDraftPresence = typeof ComposerDraftPresence.Type;

/** The source token stays in the originating profile and never enters read models. */
export const ComposerDraftPresenceSource = Schema.Struct({
  sourceId: SourceIdentity,
  sourceToken: SourceIdentity,
});
export const OpenComposerDraftPresenceResult = Schema.Struct({ writerEpoch: PositiveInt });
export const ReplaceComposerDraftPresenceInput = Schema.Struct({
  ...ComposerDraftPresenceSource.fields,
  writerEpoch: PositiveInt,
  revision: PositiveInt,
  entries: Schema.Array(ComposerDraftPresenceEntry).check(Schema.isMaxLength(2048)),
});
export type ReplaceComposerDraftPresenceInput = typeof ReplaceComposerDraftPresenceInput.Type;

export class ComposerDraftPresenceError extends Schema.TaggedError<ComposerDraftPresenceError>()(
  "ComposerDraftPresenceError",
  {
    reason: Schema.Literals(["source", "writer", "revision", "destination", "storage"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not accept composer presence (${this.reason}).`;
  }
}
