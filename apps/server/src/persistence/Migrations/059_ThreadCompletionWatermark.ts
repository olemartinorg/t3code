import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Read state needs real completion history even when a V1 import has no V2 run.
  // Preserve explicit native values, and leave visits and activity timestamps alone.
  yield* sql`
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(payload_json, '$.lastCompletionAt', (
      SELECT MAX(completed_at) FROM (
        SELECT completed_at FROM orchestration_v2_projection_runs
        WHERE thread_id = thread.thread_id AND completed_at IS NOT NULL
        UNION ALL
        SELECT completed_at FROM projection_turns
        WHERE thread_id = thread.thread_id AND completed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_legacy_imports
            WHERE thread_id = thread.thread_id
          )
      )
    ))
    WHERE json_type(payload_json, '$.lastCompletionAt') IS NULL
  `;
});
