import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_idle_stop_admission (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), owner_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
    boot_id TEXT NOT NULL, reservation_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE orchestration_v2_ralph_retirements (
    thread_id TEXT NOT NULL, owner_id TEXT NOT NULL, loop_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (thread_id, owner_id, loop_id, revision)
  )`;
  yield* sql`CREATE INDEX orchestration_v2_ralph_retired_owner_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.ralphRetiredBinding.ownerId'))
    WHERE archived_at IS NOT NULL AND deleted_at IS NULL`;
  yield* sql`CREATE INDEX orchestration_v2_ralph_pending_outcomes_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal, run_id)
    WHERE json_extract(payload_json, '$.ralphOutcome.disposition') = 'pending'`;
  yield* sql`CREATE INDEX orchestration_v2_ralph_outcome_identity_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.ralphOutcome.eventId'))
    WHERE json_extract(payload_json, '$.ralphOutcome.eventId') IS NOT NULL`;
});
