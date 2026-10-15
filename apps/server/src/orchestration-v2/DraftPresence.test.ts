import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as DraftPresence from "./DraftPresence.ts";

const environmentId = EnvironmentId.make("presence-environment");
const environment = Layer.mock(ServerEnvironment)({
  getEnvironmentId: Effect.succeed(environmentId),
});
const testLayer = DraftPresence.layer.pipe(
  Layer.provide(environment),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
const projectId = ProjectId.make("presence-project");
const threadId = ThreadId.make("presence-thread");
const first = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  sourceToken: "11111111-2222-4222-8222-111111111111",
};
const second = {
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceToken: "22222222-1111-4111-8111-222222222222",
};
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Presence','/tmp/presence','[]','2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
    VALUES (${threadId},${projectId},'Thread','codex','full-access','default','2026-01-01','2026-01-01','{}')`;
});

it.effect(
  "retains independent complete reports and fences stale writers without touching thread clocks",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* DraftPresence.DraftPresence;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* service.openSource(first);
      const b = yield* service.openSource(second);
      const report = { ...first, ...a, revision: 1, entries: [{ projectId, threadId }] };
      yield* service.replace(report);
      yield* service.replace(report);
      assert.equal((yield* service.snapshot).revision, 1);
      yield* service.replace({
        ...second,
        ...b,
        revision: 1,
        entries: [{ projectId, draftId: "local" }],
      });
      yield* service.replace({ ...first, ...a, revision: 2, entries: [] });
      assert.deepEqual((yield* service.snapshot).projects, [
        { projectId, threadIds: [], hasProjectDraft: true },
      ]);
      const reopened = yield* service.openSource(second);
      assert.deepEqual((yield* service.snapshot).projects, [
        { projectId, threadIds: [], hasProjectDraft: true },
      ]);
      assert.equal(
        (yield* Effect.flip(service.replace({ ...second, ...b, revision: 2, entries: [] }))).reason,
        "writer",
      );
      assert.equal(
        (yield* Effect.flip(service.openSource({ ...first, sourceToken: second.sourceToken })))
          .reason,
        "source",
      );
      yield* service.replace({ ...second, ...reopened, revision: 1, entries: [] });
      assert.deepEqual((yield* service.snapshot).projects, []);
      assert.deepEqual(yield* sql`SELECT updated_at FROM orchestration_v2_projection_threads`, [
        { updated_at: "2026-01-01" },
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects deleted destinations atomically and filters hidden native threads", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DraftPresence.DraftPresence;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.openSource(first);
    yield* service.replace({
      ...first,
      ...opened,
      revision: 1,
      entries: [{ projectId, threadId }],
    });
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"lineage":{"relationshipToParent":"subagent"}}'`;
    assert.deepEqual((yield* service.snapshot).projects, []);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}', deleted_at = '2026-01-02'`;
    const error = yield* Effect.flip(
      service.replace({
        ...first,
        ...opened,
        revision: 2,
        entries: [
          { projectId, draftId: "new" },
          { projectId, threadId },
        ],
      }),
    );
    assert.equal(error.reason, "destination");
    assert.equal((yield* service.snapshot).revision, 1);
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-02'`;
    assert.equal(
      (yield* Effect.flip(
        service.replace({
          ...first,
          ...opened,
          revision: 2,
          entries: [{ projectId, draftId: "new" }],
        }),
      )).reason,
      "destination",
    );
  }).pipe(Effect.provide(testLayer)),
);
