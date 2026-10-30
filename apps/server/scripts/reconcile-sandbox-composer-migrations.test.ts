import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import FailureIndex from "../src/persistence/Migrations/062_ThreadFailureLookupIndex.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import { reconcileSandboxComposerMigrations } from "./reconcile-sandbox-composer-migrations.ts";

const Composer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE composer_draft_presence_sources (
    source_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, writer_epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL, entries_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE composer_draft_presence_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)`;
  yield* sql`INSERT INTO composer_draft_presence_revision VALUES (1, 0)`;
});

const forkDatabase = (withFailureIndex: boolean | "68") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: withFailureIndex === "68" ? 67 : 61 });
    yield* Composer;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (${withFailureIndex === "68" ? 68 : 62}, 'ComposerDraftPresence')`;
    if (withFailureIndex === true) {
      yield* FailureIndex;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'ThreadFailureLookupIndex')`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('retained-thread', 'project', 'Accepted conversation', 'codex', 'full-access', 'default', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '{}')`;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
    VALUES ('session', 'retained-user', '["read","write"]', 'bearer', '2026-10-20T12:00:00Z', '2026-11-20T12:00:00Z')`;
    yield* sql`INSERT INTO orchestration_v2_effect_outbox
    (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
    VALUES ('effect', 'command', 'retained-thread', 'provider.send', '{"text":"accepted pending message"}', 'pending', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z')`;
    yield* sql`INSERT INTO orchestration_v2_command_receipts
    (command_id, thread_id, command_type, accepted_at, result_sequence, status)
    VALUES ('command', 'retained-thread', 'thread.send', '2026-10-20T12:00:00Z', 17, 'accepted')`;
    yield* sql`INSERT INTO composer_draft_presence_sources VALUES ('desktop', 'private-hash', 3, 9, '[{"draft":"retained"}]')`;
    yield* sql`UPDATE composer_draft_presence_revision SET revision = 23`;
    yield* sql`
    INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('message', 'retained-thread', 'user', 0, '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '{"text":"retained conversation"}')
  `;
  });

it.effect.each([false, true, "68"] as const)(
  "converts released fork ledger, with failure index: %s",
  (withIndex) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkDatabase(withIndex);
      const retained = () =>
        Effect.all({
          messages: sql`SELECT * FROM orchestration_v2_projection_messages`,
          identities: sql`SELECT thread_id, project_id, created_at FROM orchestration_v2_projection_threads`,
          auth: sql`SELECT * FROM auth_sessions`,
          outbox: sql`SELECT * FROM orchestration_v2_effect_outbox`,
          receipts: sql`SELECT * FROM orchestration_v2_command_receipts`,
        });
      const before = yield* retained();
      const result = yield* reconcileSandboxComposerMigrations();
      assert.deepEqual(
        result.migrated,
        migrationManifest.filter(([id]) => id >= (withIndex === "68" ? 68 : 62)),
      );
      assert.deepEqual(yield* retained(), before);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'composer_draft_presence_%'`,
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
      );
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'sandbox_preserved_composer_%'`,
        [],
      );
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
    assert.deepEqual(yield* sql`SELECT revision FROM composer_draft_presence_revision`, [
      { revision: 23 },
    ]);
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_failed_error_idx'`,
      [{ name: "orchestration_v2_projection_turn_items_failed_error_idx" }],
    );
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'sandbox_preserved_composer_%'`,
      [],
    );
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

it.effect("fresh native databases never create retired presence tables or require conversion", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'composer_draft_presence_%'`,
      [],
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["unknown-name", "extra-migration", "wrong-prefix"])(
  "refuses unsupported ledger %s before discarding custom data",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkDatabase("68");
      if (kind === "unknown-name")
        yield* sql`UPDATE effect_sql_migrations SET name = 'Unknown' WHERE migration_id = 68`;
      if (kind === "extra-migration")
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (69, 'Unknown')`;
      if (kind === "wrong-prefix")
        yield* sql`UPDATE effect_sql_migrations SET name = 'Unknown' WHERE migration_id = 61`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileSandboxComposerMigrations())));
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepEqual(yield* sql`SELECT revision FROM composer_draft_presence_revision`, [
        { revision: 23 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
