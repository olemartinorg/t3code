// @effect-diagnostics nodeBuiltinImport:off - Isolated packaged-converter acceptance.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeAssert from "node:assert";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import FailureIndex from "../src/persistence/Migrations/062_ThreadFailureLookupIndex.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";

const fixtures = process.argv[2] === "--fixtures" ? NodePath.resolve(process.argv[3]!) : null;
if (fixtures) await NodeFSP.mkdir(fixtures, { recursive: true });
const converter = NodePath.resolve(
  process.argv[2] ?? "dist/reconcile-sandbox-composer-migrations.mjs",
);
const fixtureRoot = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "t3-retired-draft-package-"),
);
const native = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false }),
      ),
    ),
  );
try {
  const cases = [];
  for (const ledger of [62, 63, 68]) {
    const directory = NodePath.join(fixtureRoot, String(ledger));
    await NodeFSP.mkdir(directory);
    const filename = NodePath.join(directory, "statev2.sqlite");
    await native(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: ledger === 68 ? 67 : 61 });
        yield* sql`CREATE TABLE composer_draft_presence_sources (source_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, writer_epoch INTEGER NOT NULL, revision INTEGER NOT NULL, entries_json TEXT NOT NULL)`;
        yield* sql`CREATE TABLE composer_draft_presence_revision (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)`;
        yield* sql`INSERT INTO composer_draft_presence_revision VALUES (1, 23)`;
        yield* sql`INSERT INTO composer_draft_presence_sources VALUES ('discard-only', 'hash', 1, 3, '[]')`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${ledger === 68 ? 68 : 62}, 'ComposerDraftPresence')`;
        if (ledger === 63) {
          yield* FailureIndex;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'ThreadFailureLookupIndex')`;
        }
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('accepted', 'project', 'Accepted conversation', 'codex', 'full-access', 'default', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message', 'accepted', 'user', 0, '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '{"text":"Accepted message with attachment","attachments":[{"id":"shared-asset"}]}')`;
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('auth', 'subject', '["read","write"]', 'bearer', '2026-10-20T12:00:00Z', '2026-11-20T12:00:00Z')`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES ('effect', 'command', 'accepted', 'provider.send', '{"text":"Accepted pending send"}', 'pending', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z')`;
        yield* sql`INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status)
        VALUES ('command', 'accepted', 'thread.send', '2026-10-20T12:00:00Z', 17, 'accepted')`;
      }),
    );
    if (fixtures) {
      await NodeFSP.copyFile(filename, NodePath.join(fixtures, `${ledger}.sqlite`));
      continue;
    }
    const read = () => {
      const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        return Object.fromEntries(
          [
            "orchestration_v2_projection_messages",
            "auth_sessions",
            "orchestration_v2_effect_outbox",
            "orchestration_v2_command_receipts",
          ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
        );
      } finally {
        db.close();
      }
    };
    const before = read();
    const receipt = JSON.parse(
      NodeChildProcess.execFileSync(process.execPath, [converter, filename], { encoding: "utf8" })
        .trim()
        .split("\n")
        .at(-1)!,
    );
    NodeAssert.strict.deepEqual(read(), before);
    await native(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        NodeAssert.strict.deepEqual(yield* runMigrations(), []);
        NodeAssert.strict.deepEqual(
          (yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
            (row) => ({ ...row }),
          ),
          migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
        );
        NodeAssert.strict.deepEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'composer_draft_presence_%'`,
          [],
        );
        NodeAssert.strict.deepEqual(
          (yield* sql`SELECT thread_id, project_id, created_at FROM orchestration_v2_projection_threads`).map(
            (row) => ({ ...row }),
          ),
          [{ thread_id: "accepted", project_id: "project", created_at: "2026-10-20T12:00:00Z" }],
        );
      }),
    );
    cases.push({
      ledger,
      packagedConversion: true,
      nativeReopen: true,
      nonDraftValuesExact: true,
      ...receipt,
    });
  }
  const fresh = NodePath.join(fixtureRoot, "fresh.sqlite");
  await native(
    fresh,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      NodeAssert.strict.deepEqual(yield* runMigrations(), []);
      NodeAssert.strict.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'composer_draft_presence_%'`,
        [],
      );
    }),
  );
  process.stdout.write(`${JSON.stringify({ converter, cases, freshNativeDatabase: true })}\n`);
} finally {
  await NodeFSP.rm(fixtureRoot, { recursive: true, force: true });
}
