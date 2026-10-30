import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { CommandId } from "@t3tools/contracts";
import {
  fixture,
  layerTest,
  makeLayer,
  binding,
  projectId,
  threadId,
} from "./testkit/RalphHarness.ts";

const owner = { ownerId: "sandbox-owner", runtimeId: "container-one" };
it.effect("Arm committed first excludes automatic Stop; native retirement releases the hold", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { bootId } = yield* f.sink.idleStop({ action: "inspect", ...owner });
    assert.deepStrictEqual(yield* f.control("arm", { kind: "arm" }), { kind: "armed" });
    assert.strictEqual(
      (yield* f.sink.idleStop({ action: "reserve", ...owner, bootId, reservationId: "stop" }))
        .result,
      "blocked",
    );
    yield* f.control("retire", { kind: "retire", decisions: [] });
    assert.strictEqual(
      (yield* f.sink.idleStop({ action: "reserve", ...owner, bootId, reservationId: "stop" }))
        .result,
      "reserved",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "file-backed unknown Stop survives native close/reopen until exact returning replacement facts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ralph-stop-reservation-" });
      const disk = makeLayer(SqlitePersistence.layerFromPath(`${root}/native.sqlite`));
      const prior = yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const { bootId } = yield* f.sink.idleStop({ action: "inspect", ...owner });
          const reservation = { ...owner, bootId, reservationId: "unknown-stop" };
          assert.strictEqual(
            (yield* f.sink.idleStop({ action: "reserve", ...reservation })).result,
            "reserved",
          );
          return reservation;
        }).pipe(Effect.provide(disk)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const engine = yield* Orchestrator.OrchestratorV2;
          const replacement = { ...owner, runtimeId: "container-two" };
          const inspected = yield* sink.idleStop({ action: "inspect", ...replacement });
          assert.notStrictEqual(inspected.bootId, prior.bootId);
          assert.deepStrictEqual(inspected.reservation, prior);
          const arm = {
            type: "ralph.control" as const,
            commandId: CommandId.make("arm-before-reconcile"),
            threadId,
            projectId,
            binding,
            action: { kind: "arm" as const },
          };
          yield* engine.dispatch(arm);
          assert.deepStrictEqual(
            yield* engine.getRalphCommandReceipt(binding.ownerId, arm.commandId),
            { kind: "receipt", receipt: { kind: "rejected", reason: "stopping" } },
          );
          assert.strictEqual(
            (yield* sink.idleStop({
              action: "reconcile",
              ...prior,
              observedBootId: inspected.bootId,
              outcome: "stop-failed",
            })).result,
            "identity-changed",
          );
          assert.strictEqual(
            (yield* sink.idleStop({
              action: "reconcile",
              ...prior,
              observedBootId: inspected.bootId,
              outcome: "native-replaced",
            })).result,
            "released",
          );
          const fresh = { ...arm, commandId: CommandId.make("arm-after-reconcile") };
          yield* engine.dispatch(fresh);
          assert.deepStrictEqual(
            yield* engine.getRalphCommandReceipt(binding.ownerId, fresh.commandId),
            { kind: "receipt", receipt: { kind: "armed" } },
          );
          yield* engine.dispatch({
            ...fresh,
            commandId: CommandId.make("retire-new-runtime"),
            action: { kind: "retire", decisions: [] },
          });
          assert.strictEqual(
            (yield* sink.idleStop({
              action: "reserve",
              ...replacement,
              bootId: inspected.bootId,
              reservationId: "later-stop",
            })).result,
            "reserved",
          );
        }).pipe(Effect.provide(disk)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reserved Stop excludes Arm and exact failed Stop release allows a fresh identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { bootId } = yield* f.sink.idleStop({ action: "inspect", ...owner });
    const reservation = { ...owner, bootId, reservationId: "stop-one" };
    assert.strictEqual(
      (yield* f.sink.idleStop({ action: "reserve", ...reservation })).result,
      "reserved",
    );
    assert.strictEqual(
      (yield* f.sink.idleStop({ action: "reserve", ...reservation })).result,
      "reserved",
    );
    assert.deepStrictEqual(yield* f.control("arm-refused", { kind: "arm" }), {
      kind: "rejected",
      reason: "stopping",
    });
    for (const change of [
      { ownerId: "other" },
      { runtimeId: "other" },
      { bootId: "other" },
      { reservationId: "other" },
    ]) {
      assert.strictEqual(
        (yield* f.sink.idleStop({ action: "release", ...reservation, ...change })).result,
        "identity-changed",
      );
      assert.strictEqual(
        (yield* f.sink.idleStop({ action: "reserve", ...reservation, ...change })).result ===
          "reserved",
        false,
      );
    }
    assert.strictEqual((yield* f.sink.idleStop({ action: "inspect", ...owner })).result, "blocked");
    assert.strictEqual(
      (yield* f.sink.idleStop({
        action: "reconcile",
        ...reservation,
        observedBootId: "wrong",
        outcome: "stop-failed",
      })).result,
      "identity-changed",
    );
    assert.strictEqual(
      (yield* f.sink.idleStop({ action: "release", ...reservation })).result,
      "released",
    );
    assert.deepStrictEqual(yield* f.control("fresh-arm", { kind: "arm" }), { kind: "armed" });
    assert.deepStrictEqual(yield* f.control("arm-refused", { kind: "arm" }), {
      kind: "rejected",
      reason: "stopping",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "unknown old owner reservation stays fenced until exact returning native replacement facts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { bootId } = yield* f.sink.idleStop({ action: "inspect", ...owner });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_idle_stop_admission VALUES (1, 'sandbox-owner', 'container-one', 'prior-boot', 'unknown-stop')`;
      const prior = { ...owner, bootId: "prior-boot", reservationId: "unknown-stop" };
      assert.strictEqual(
        (yield* f.sink.idleStop({ action: "inspect", ...owner })).result,
        "blocked",
      );
      assert.strictEqual(
        (yield* f.sink.idleStop({ action: "reserve", ...owner, bootId, reservationId: "new-stop" }))
          .result,
        "blocked",
      );
      assert.deepStrictEqual(yield* f.control("blocked-arm", { kind: "arm" }), {
        kind: "rejected",
        reason: "stopping",
      });
      assert.strictEqual(
        (yield* f.sink.idleStop({
          action: "reconcile",
          ...prior,
          observedBootId: bootId,
          outcome: "stop-failed",
        })).result,
        "identity-changed",
      );
      assert.strictEqual(
        (yield* f.sink.idleStop({
          action: "reconcile",
          ...prior,
          runtimeId: "replacement-runtime",
          observedBootId: bootId,
          outcome: "native-replaced",
        })).result,
        "identity-changed",
      );
      assert.strictEqual(
        (yield* f.sink.idleStop({
          action: "reconcile",
          ...prior,
          observedBootId: bootId,
          outcome: "native-replaced",
        })).result,
        "released",
      );
      assert.deepStrictEqual(yield* f.control("returning-arm", { kind: "arm" }), { kind: "armed" });
    }).pipe(Effect.provide(layerTest)),
);
