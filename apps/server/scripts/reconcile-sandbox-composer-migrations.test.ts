import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import FailureIndex from "../src/persistence/Migrations/062_ThreadFailureLookupIndex.ts";
import Composer from "../src/persistence/Migrations/068_ComposerDraftPresence.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import { reconcileSandboxComposerMigrations } from "./reconcile-sandbox-composer-migrations.ts";

const forkDatabase = (withFailureIndex: boolean) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 61 });
  yield* Composer;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'ComposerDraftPresence')`;
  if (withFailureIndex) {
    yield* FailureIndex;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'ThreadFailureLookupIndex')`;
  }
  yield* sql`INSERT INTO composer_draft_presence_sources VALUES ('desktop', 'private-hash', 3, 9, '[{"draft":"retained"}]')`;
  yield* sql`UPDATE composer_draft_presence_revision SET revision = 23`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('message', 'retained-thread', 'user', 0, '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '{"text":"retained conversation"}')
  `;
});

it.effect.each([false, true])("converts released fork ledger, with failure index: %s", (withIndex) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* forkDatabase(withIndex);
    const messages = yield* sql`SELECT * FROM orchestration_v2_projection_messages`;
    const sources = yield* sql`SELECT * FROM composer_draft_presence_sources`;
    const result = yield* reconcileSandboxComposerMigrations();
    assert.deepEqual(result.migrated, migrationManifest.filter(([id]) => id >= 62));
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_messages`, messages);
    assert.deepEqual(yield* sql`SELECT * FROM composer_draft_presence_sources`, sources);
    assert.deepEqual(yield* sql`SELECT * FROM composer_draft_presence_revision`, [{ singleton: 1, revision: 23 }]);
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'sandbox_preserved_composer_%'`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rolls back both the conversion and native migrations when a later migration fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* forkDatabase(true);
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_webhook_delivery_id TEXT`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const exit = yield* Effect.exit(reconcileSandboxComposerMigrations());
    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
    assert.deepEqual(yield* sql`SELECT revision FROM composer_draft_presence_revision`, [{ revision: 23 }]);
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_failed_error_idx'`, [
      { name: "orchestration_v2_projection_turn_items_failed_error_idx" },
    ]);
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'sandbox_preserved_composer_%'`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects a different composer schema before changing the ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* forkDatabase(true);
    yield* sql`ALTER TABLE composer_draft_presence_sources ADD COLUMN unsupported TEXT`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const exit = yield* Effect.exit(reconcileSandboxComposerMigrations());
    assert.isTrue(Exit.isFailure(exit));
    assert.include(String(exit), "do not match the released schema");
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
