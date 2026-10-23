// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";

class ComposerMigrationError extends Schema.TaggedError<ComposerMigrationError>()("ComposerMigrationError", { message: Schema.String }) {}

const sourceTable = "composer_draft_presence_sources";
const revisionTable = "composer_draft_presence_revision";
const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
const expectedSchemas = new Map([
  [sourceTable, `CREATE TABLE composer_draft_presence_sources (
    source_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, writer_epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL, entries_json TEXT NOT NULL)`],
  [revisionTable, `CREATE TABLE composer_draft_presence_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)`],
]);
const fingerprint = (rows: ReadonlyArray<unknown>) =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Explicit offline conversion for the released Sandbox fork only. Normal server
// startup continues to reject divergent ledgers instead of repairing them.
export const reconcileSandboxComposerMigrations = Effect.fn("reconcileSandboxComposerMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(Effect.gen(function* () {
      const fail = (message: string) => Effect.fail(new ComposerMigrationError({ message }));
      const recorded = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const expectedPrefix = migrationManifest.filter(([id]) => id <= 61);
      if (recorded.length !== 62 && recorded.length !== 63)
        return yield* fail("Expected the released Sandbox migration ledger ending at 62 or 63.");
      for (const [id, name] of expectedPrefix) {
        if (!recorded.some((entry) => entry.migration_id === id && entry.name === name))
          return yield* fail(`Unexpected migration history at ${id}_${name}.`);
      }
      if (recorded[61]?.migration_id !== 62 || recorded[61].name !== "ComposerDraftPresence" ||
        (recorded[62] !== undefined && (recorded[62].migration_id !== 63 || recorded[62].name !== "ThreadFailureLookupIndex")))
        return yield* fail("This database does not have the released Sandbox composer migration collision.");

      const schemas = yield* sql<{ name: string; sql: string }>`
        SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND (name LIKE 'composer_draft_presence_%' OR name LIKE 'sandbox_preserved_composer_%')
      `;
      if (schemas.length !== 2 || schemas.some((row) => normalize(row.sql) !== normalize(expectedSchemas.get(row.name) ?? "")))
        return yield* fail("Composer presence tables do not match the released schema.");
      const failureIndexes = yield* sql<{ sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'index'
        AND name = 'orchestration_v2_projection_turn_items_failed_error_idx'
      `;
      const expectedIndex = `CREATE INDEX orchestration_v2_projection_turn_items_failed_error_idx
        ON orchestration_v2_projection_turn_items(thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC)
        WHERE type = 'error' AND status = 'failed'`;
      if (failureIndexes.length !== (recorded.length === 63 ? 1 : 0) ||
        failureIndexes.some((row) => normalize(row.sql) !== normalize(expectedIndex)))
        return yield* fail("Failure lookup index does not match the released migration ledger.");

      const sources = yield* sql`SELECT * FROM composer_draft_presence_sources ORDER BY source_id`;
      const revisions = yield* sql`SELECT * FROM composer_draft_presence_revision ORDER BY singleton`;
      if (revisions.length !== 1 || revisions[0]?.singleton !== 1)
        return yield* fail("Composer revision singleton is missing or invalid.");
      // Native migrations normalize PR links and settlement metadata, but never
      // change conversation bodies, stable thread identity, or authorization.
      const retained = () => Effect.all({
        messages: sql`SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id`,
        identities: sql`SELECT thread_id, project_id, created_at FROM orchestration_v2_projection_threads ORDER BY thread_id`,
        auth: sql`SELECT * FROM auth_sessions ORDER BY session_id`,
      });
      const before = fingerprint([yield* retained(), sources, revisions]);

      yield* sql`ALTER TABLE composer_draft_presence_sources RENAME TO sandbox_preserved_composer_sources`;
      yield* sql`ALTER TABLE composer_draft_presence_revision RENAME TO sandbox_preserved_composer_revision`;
      if (recorded.length === 63)
        yield* sql`DROP INDEX orchestration_v2_projection_turn_items_failed_error_idx`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (62, 63)`;
      const migrated = yield* runMigrations();
      yield* sql`INSERT INTO composer_draft_presence_sources SELECT * FROM sandbox_preserved_composer_sources`;
      yield* sql`DELETE FROM composer_draft_presence_revision`;
      yield* sql`INSERT INTO composer_draft_presence_revision SELECT * FROM sandbox_preserved_composer_revision`;
      yield* sql`DROP TABLE sandbox_preserved_composer_sources`;
      yield* sql`DROP TABLE sandbox_preserved_composer_revision`;
      const after = fingerprint([
        yield* retained(),
        yield* sql`SELECT * FROM composer_draft_presence_sources ORDER BY source_id`,
        yield* sql`SELECT * FROM composer_draft_presence_revision ORDER BY singleton`,
      ]);
      if (before !== after) return yield* fail("Retained conversations, identities, authorization or draft data changed.");
      const history = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      if (!Equal.equals(history.map((row) => [row.migration_id, row.name]), migrationManifest))
        return yield* fail("The converted ledger does not match the selected native migration manifest.");
      return { migrated, retainedSha256: after };
    }));
  },
);

if (import.meta.main) {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) throw new Error("Usage: reconcile-sandbox-composer-migrations.ts <offline-statev2.sqlite>");
  const result = await Effect.runPromise(reconcileSandboxComposerMigrations().pipe(
    Effect.provide(NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false })),
  ));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
