import {
  ComposerDraftPresenceError,
  type ComposerDraftPresence,
  type ComposerDraftPresenceEntry,
  type ComposerDraftPresenceSource,
  type ReplaceComposerDraftPresenceInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export class DraftPresence extends Context.Service<
  DraftPresence,
  {
    readonly snapshot: Effect.Effect<ComposerDraftPresence, ComposerDraftPresenceError>;
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<ComposerDraftPresence>,
      never,
      Scope.Scope
    >;
    readonly openSource: (
      input: typeof ComposerDraftPresenceSource.Type,
    ) => Effect.Effect<{ writerEpoch: number }, ComposerDraftPresenceError>;
    readonly replace: (
      input: ReplaceComposerDraftPresenceInput,
    ) => Effect.Effect<void, ComposerDraftPresenceError>;
  }
>()("t3/orchestration-v2/DraftPresence") {}

const isPresenceError = Schema.is(ComposerDraftPresenceError);
const canonicalEntries = (entries: ReadonlyArray<ComposerDraftPresenceEntry>) =>
  JSON.stringify(
    [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
      (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const tokenHash = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Hex.encode));
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const changes = yield* PubSub.sliding<ComposerDraftPresence>(1);
  const writes = yield* Semaphore.make(1);
  const storageError = (cause: unknown) =>
    isPresenceError(cause) ? cause : new ComposerDraftPresenceError({ reason: "storage", cause });

  const snapshot = Effect.gen(function* () {
    const revisions = yield* sql<{
      readonly revision: number;
    }>`SELECT revision FROM composer_draft_presence_revision WHERE singleton = 1`;
    const entries = yield* sql<{ readonly projectId: string; readonly threadId: string | null }>`
      SELECT DISTINCT json_extract(e.value, '$.projectId') AS "projectId",
        json_extract(e.value, '$.threadId') AS "threadId"
      FROM composer_draft_presence_sources s, json_each(s.entries_json) e
      JOIN projection_projects p ON p.project_id = json_extract(e.value, '$.projectId') AND p.deleted_at IS NULL
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = json_extract(e.value, '$.threadId')
        AND t.project_id = p.project_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
      WHERE json_extract(e.value, '$.threadId') IS NULL OR (
        t.thread_id IS NOT NULL
        AND json_extract(t.payload_json, '$.settledAt') IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
      )
      ORDER BY "projectId", "threadId"
    `;
    const projects = new Map<
      string,
      { projectId: ProjectId; threadIds: ThreadId[]; hasProjectDraft: boolean }
    >();
    for (const entry of entries) {
      const project = projects.get(entry.projectId) ?? {
        projectId: ProjectId.make(entry.projectId),
        threadIds: [],
        hasProjectDraft: false,
      };
      if (entry.threadId === null) project.hasProjectDraft = true;
      else project.threadIds.push(ThreadId.make(entry.threadId));
      projects.set(entry.projectId, project);
    }
    return { environmentId, revision: revisions[0]!.revision, projects: [...projects.values()] };
  }).pipe(Effect.mapError(storageError));

  const source = (sourceId: string) => sql<{
    readonly tokenHash: string;
    readonly writerEpoch: number;
    readonly revision: number;
    readonly entries: string;
  }>`SELECT token_hash AS "tokenHash", writer_epoch AS "writerEpoch", revision, entries_json AS entries
    FROM composer_draft_presence_sources WHERE source_id = ${sourceId}`;

  const openSource: DraftPresence["Service"]["openSource"] = (input) =>
    writes
      .withPermit(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = (yield* source(input.sourceId))[0];
            const hash = yield* tokenHash(input.sourceToken);
            if (existing && existing.tokenHash !== hash)
              return yield* new ComposerDraftPresenceError({ reason: "source" });
            const writerEpoch = (existing?.writerEpoch ?? 0) + 1;
            yield* sql`INSERT INTO composer_draft_presence_sources (source_id, token_hash, writer_epoch, revision, entries_json)
      VALUES (${input.sourceId}, ${hash}, ${writerEpoch}, 0, '[]')
      ON CONFLICT(source_id) DO UPDATE SET writer_epoch = excluded.writer_epoch, revision = 0`;
            return { writerEpoch };
          }),
        ),
      )
      .pipe(Effect.mapError(storageError));

  const replace: DraftPresence["Service"]["replace"] = (input) =>
    writes
      .withPermit(
        Effect.gen(function* () {
          const changed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = (yield* source(input.sourceId))[0];
              const hash = yield* tokenHash(input.sourceToken);
              if (!existing || existing.tokenHash !== hash)
                return yield* new ComposerDraftPresenceError({ reason: "source" });
              if (existing.writerEpoch !== input.writerEpoch)
                return yield* new ComposerDraftPresenceError({ reason: "writer" });
              const entries = canonicalEntries(input.entries);
              if (
                input.revision < existing.revision ||
                (input.revision === existing.revision && entries !== existing.entries)
              )
                return yield* new ComposerDraftPresenceError({ reason: "revision" });
              if (input.revision === existing.revision) return false;
              for (const entry of input.entries) {
                const projects =
                  yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${entry.projectId} AND deleted_at IS NULL`;
                if (projects.length === 0)
                  return yield* new ComposerDraftPresenceError({ reason: "destination" });
                if ("threadId" in entry) {
                  const threads =
                    yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${entry.threadId} AND project_id = ${entry.projectId} AND deleted_at IS NULL`;
                  if (threads.length === 0)
                    return yield* new ComposerDraftPresenceError({ reason: "destination" });
                }
              }
              yield* sql`UPDATE composer_draft_presence_sources SET revision = ${input.revision}, entries_json = ${entries} WHERE source_id = ${input.sourceId}`;
              if (entries === existing.entries) return false;
              yield* sql`UPDATE composer_draft_presence_revision SET revision = revision + 1 WHERE singleton = 1`;
              return true;
            }),
          );
          // Only metadata is published. No orchestration event or thread clock changes.
          if (changed) yield* PubSub.publish(changes, yield* snapshot);
        }),
      )
      .pipe(Effect.mapError(storageError), Effect.asVoid);

  return DraftPresence.of({
    snapshot,
    openSource,
    replace,
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(DraftPresence, make);
