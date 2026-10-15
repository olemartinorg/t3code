import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE composer_draft_presence_sources (
    source_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    writer_epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    entries_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE composer_draft_presence_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO composer_draft_presence_revision VALUES (1, 0)`;
});
