// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";

class ComposerMigrationError extends Schema.TaggedError<ComposerMigrationError>()(
  "ComposerMigrationError",
  { message: Schema.String },
) {}

const sourceTable = "composer_draft_presence_sources";
const revisionTable = "composer_draft_presence_revision";
const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
const expectedSchemas = new Map([
  [
    sourceTable,
    `CREATE TABLE composer_draft_presence_sources (
    source_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, writer_epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL, entries_json TEXT NOT NULL)`,
  ],
  [
    revisionTable,
    `CREATE TABLE composer_draft_presence_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)`,
  ],
]);
const fingerprint = (rows: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Explicit offline conversion for the released Sandbox fork only. Normal server
// startup continues to reject divergent ledgers instead of repairing them.
export const reconcileSandboxComposerMigrations = Effect.fn("reconcileSandboxComposerMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const fail = (message: string) => Effect.fail(new ComposerMigrationError({ message }));
        const recorded = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
        const releasedCollision = recorded.length === 62 || recorded.length === 63;
        const retired68 =
          recorded.length === 68 &&
          recorded[67]?.migration_id === 68 &&
          recorded[67].name === "ComposerDraftPresence";
        const prefixLength = releasedCollision ? 61 : retired68 ? 67 : 0;
        if (!prefixLength)
          return yield* fail(
            "Expected the released Sandbox ledger ending at custom 62, 62+63 or 68.",
          );
        const expectedPrefix = migrationManifest.filter(([id]) => id <= prefixLength);
        if (
          expectedPrefix.length !== prefixLength ||
          !Equal.equals(
            recorded.slice(0, prefixLength).map((entry) => [entry.migration_id, entry.name]),
            expectedPrefix,
          )
        )
          return yield* fail("The native prefix does not match the selected migration manifest.");
        if (
          releasedCollision &&
          (recorded[61]?.migration_id !== 62 ||
            recorded[61].name !== "ComposerDraftPresence" ||
            (recorded[62] !== undefined &&
              (recorded[62].migration_id !== 63 ||
                recorded[62].name !== "ThreadFailureLookupIndex")))
        )
          return yield* fail(
            "This database does not have the released Sandbox migration collision.",
          );

        const schemas = yield* sql<{ name: string; sql: string }>`
        SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND (name LIKE 'composer_draft_presence_%' OR name LIKE 'sandbox_preserved_composer_%')
      `;
        if (
          schemas.length !== 2 ||
          schemas.some(
            (row) => normalize(row.sql) !== normalize(expectedSchemas.get(row.name) ?? ""),
          )
        )
          return yield* fail("Composer presence tables do not match the released schema.");
        const failureIndexes = yield* sql<{ sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'index'
        AND name = 'orchestration_v2_projection_turn_items_failed_error_idx'
      `;
        const expectedIndex = `CREATE INDEX orchestration_v2_projection_turn_items_failed_error_idx
        ON orchestration_v2_projection_turn_items(thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC)
        WHERE type = 'error' AND status = 'failed'`;
        if (
          failureIndexes.length !== (recorded.length === 63 || retired68 ? 1 : 0) ||
          failureIndexes.some((row) => normalize(row.sql) !== normalize(expectedIndex))
        )
          return yield* fail("Failure lookup index does not match the released migration ledger.");

        // Native migrations may normalize PR links and settlement metadata. Protect
        // accepted messages, identities, authorization, pending effects and receipts.
        const retained = () =>
          Effect.all({
            messages: sql`SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id`,
            identities: sql`SELECT thread_id, project_id, created_at FROM orchestration_v2_projection_threads ORDER BY thread_id`,
            auth: sql`SELECT * FROM auth_sessions ORDER BY session_id`,
            outbox: sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
            receipts: sql`SELECT * FROM orchestration_v2_command_receipts ORDER BY command_id`,
          });
        const before = fingerprint(yield* retained());
        yield* sql`DROP TABLE composer_draft_presence_sources`;
        yield* sql`DROP TABLE composer_draft_presence_revision`;
        if (releasedCollision) {
          if (recorded.length === 63)
            yield* sql`DROP INDEX orchestration_v2_projection_turn_items_failed_error_idx`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (62, 63)`;
        } else {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 68 AND name = 'ComposerDraftPresence'`;
        }
        const migrated = yield* runMigrations();
        const after = fingerprint(yield* retained());
        if (before !== after)
          return yield* fail(
            "Retained conversations, identities, authorization, outbox or receipts changed.",
          );
        const history = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
        if (
          !Equal.equals(
            history.map((row) => [row.migration_id, row.name]),
            migrationManifest,
          )
        )
          return yield* fail(
            "The converted ledger does not match the selected native migration manifest.",
          );
        return { migrated, retainedSha256: after };
      }),
    );
  },
);

if (import.meta.main) {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3)
    throw new Error("Usage: reconcile-sandbox-composer-migrations.ts <offline-statev2.sqlite>");
  const result = await Effect.runPromise(
    reconcileSandboxComposerMigrations().pipe(
      Effect.provide(
        NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false }),
      ),
    ),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
