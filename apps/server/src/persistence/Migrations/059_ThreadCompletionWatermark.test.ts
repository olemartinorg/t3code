import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))("completion watermark migration", (it) => {
  it.effect("backfills real V1 and V2 completion and preserves accepted native read state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const id of ["v1", "v2", "explicit"]) {
        const payload = id === "explicit"
          ? '{"lastCompletionAt":null,"lastVisitedAt":"2026-01-09T00:00:00.000Z"}'
          : '{"lastVisitedAt":"2026-01-01T00:00:00.000Z"}';
        yield* sql`INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, created_at, updated_at, payload_json
        ) VALUES (${id}, 'project', 'fixture', 'codex', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ${payload})`;
      }
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at) VALUES ('v1', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES ('v1', 'old-real-turn', 'completed', '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z', '[]')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
        VALUES ('native-run', 'v2', 1, 'codex', 'codex', 'completed',
          '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '{}')`;
      assert.deepEqual(yield* runMigrations(), [[59, "ThreadCompletionWatermark"]]);
      const rows = yield* sql<{ thread_id: string; payload_json: string; updated_at: string }>`
        SELECT thread_id, payload_json, updated_at FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      const byId = new Map(rows.map((row) => [row.thread_id, JSON.parse(row.payload_json)]));
      assert.equal(byId.get("v1").lastCompletionAt, "2026-01-02T00:00:00.000Z");
      assert.equal(byId.get("v2").lastCompletionAt, "2026-01-04T00:00:00.000Z");
      assert.isNull(byId.get("explicit").lastCompletionAt);
      assert.equal(byId.get("explicit").lastVisitedAt, "2026-01-09T00:00:00.000Z");
      assert.isTrue(rows.every((row) => row.updated_at === "2026-01-02T00:00:00.000Z"));
      assert.deepEqual(yield* runMigrations(), []);
      const [importRuns] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id='v1'`;
      assert.equal(importRuns!.count, 0);
    }),
  );
});
