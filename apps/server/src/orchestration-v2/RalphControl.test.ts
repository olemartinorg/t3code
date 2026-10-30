import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  TurnItemId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import {
  fixture,
  makeLayer,
  binding,
  projectId,
  threadId,
  complete,
  admittedRun,
  layerTest,
} from "./testkit/RalphHarness.ts";

it.effect(
  "native receipts replay one admitted run and one provider effect after lost acknowledgement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      const replay = yield* f.control("admit", {
        kind: "admit",
        text: "Continue",
        recovery: false,
      });
      assert.deepStrictEqual(replay, { kind: "admitted", origin: "ralph", runId: run.id });
      assert.strictEqual((yield* f.orchestrator.getThreadProjection(threadId)).runs.length, 1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE command_id = 'admit' AND effect_type = 'provider-turn.start'`;
      assert.strictEqual(rows[0]?.count, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "records bounded exact root result in the native transaction and publishes the same fact",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      const stored = yield* complete(f.sink, run, "RALPHCOMPLETE", "final", 5_000);
      const event = stored.find((row) => row.event.type === "run.updated")!.event;
      assert.strictEqual(event.type, "run.updated");
      if (event.type !== "run.updated") return;
      assert.deepStrictEqual(event.payload.ralphOutcome, {
        eventId: EventId.make("final"),
        runId: run.id,
        binding,
        admissionCommandId: CommandId.make("admit"),
        occurredAt: Date.parse("2026-10-30T02:00:00Z"),
        finalResponse: "ralph-complete",
        workDurationMs: 5_000,
        recovery: false,
        disposition: "pending",
      });
      const shell = yield* f.projections.getThreadShell(threadId);
      assert.deepStrictEqual(shell?.ralphOutcome, event.payload.ralphOutcome);
      assert.strictEqual((yield* f.projections.getRalphPendingRuns(threadId)).length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Cancel settles pending events and late resolution replays settled disposition", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const run = yield* admittedRun(f);
    yield* complete(f.sink, run, "still working");
    assert.deepStrictEqual(yield* f.control("cancel", { kind: "retire", decisions: [] }), {
      kind: "retired",
    });
    assert.deepStrictEqual(
      yield* f.control("late", {
        kind: "resolve",
        eventId: EventId.make("complete"),
        disposition: "released",
      }),
      { kind: "resolved", eventId: EventId.make("complete"), disposition: "consumed" },
    );
    assert.strictEqual((yield* f.projections.getRalphPendingRuns(threadId)).length, 0);
    assert.strictEqual((yield* f.projections.getThread(threadId)).ralphBinding, null);
    assert.deepStrictEqual(yield* f.control("cancel", { kind: "retire", decisions: [] }), {
      kind: "retired",
    });
    assert.strictEqual(
      (yield* f.projections.getRalphOutcomeRun(threadId, "complete"))?.ralphOutcome?.disposition,
      "consumed",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("retirement preserves committed release and later admitted completion is ordinary", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const run = yield* admittedRun(f);
    yield* complete(f.sink, run, "RALPHCOMPLETE");
    yield* f.control("cancel", {
      kind: "retire",
      decisions: [{ eventId: EventId.make("complete"), disposition: "released" }],
    });
    assert.strictEqual(
      (yield* f.projections.getRalphOutcomeRun(threadId, "complete"))?.ralphOutcome?.disposition,
      "released",
    );
    assert.strictEqual((yield* f.projections.getRalphPendingRuns(threadId)).length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("retire before arm and later loops cannot resurrect an old binding", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.control("cancel-first", { kind: "retire", decisions: [] });
    assert.deepStrictEqual(yield* f.control("late-arm", { kind: "arm" }), {
      kind: "rejected",
      reason: "identity-changed",
    });
    const next = { ...binding, loopId: "loop-2" };
    yield* f.control("arm-next", { kind: "arm" }, next);
    yield* f.control("cancel-next", { kind: "retire", decisions: [] }, next);
    assert.deepStrictEqual(yield* f.control("late-arm-again", { kind: "arm" }), {
      kind: "rejected",
      reason: "identity-changed",
    });
    assert.strictEqual((yield* f.orchestrator.getThreadProjection(threadId)).runs.length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Cancel does not interrupt accepted native work; completion after cutoff is ordinary",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      yield* f.control("cancel", { kind: "retire", decisions: [] });
      assert.strictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs[0]?.status,
        run.status,
      );
      yield* complete(f.sink, run, "RALPHCOMPLETE");
      assert.strictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs[0]?.ralphOutcome,
        undefined,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "quota recovery preserves the first human queue entry, model and held state (held=%s)",
  (held) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = yield* admittedRun(f);
      for (const id of ["human-first", "human-second"])
        yield* f.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId,
          text: id,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      const queued = (yield* f.orchestrator.getThreadProjection(threadId)).runs.filter(
        (run) => run.status === "queued",
      );
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("limited"),
            threadId,
            occurredAt: now,
            payload: { ...source, status: "failed", completedAt: now },
          },
          {
            type: "turn-item.updated",
            id: EventId.make("quota-error"),
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("quota-error"),
              type: "error",
              threadId,
              runId: source.id,
              nodeId: source.rootNodeId,
              providerThreadId: source.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Usage limit",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Quota reached",
                code: "quota",
                retryable: null,
                resetAt: "2026-10-30T08:00:00Z",
              },
            },
          },
          {
            type: "run.updated",
            id: EventId.make("hold"),
            threadId,
            occurredAt: now,
            payload: { ...queued[0]!, queueHeld: held },
          },
          {
            type: "run.updated",
            id: EventId.make("hold-peer"),
            threadId,
            occurredAt: now,
            payload: { ...queued[1]!, queueHeld: true },
          },
        ],
      });
      const receipt = yield* f.control("recovery", {
        kind: "admit",
        text: "Must not overtake humans",
        recovery: true,
      });
      assert.deepStrictEqual(
        receipt,
        held ? { kind: "deferred" } : { kind: "admitted", origin: "human", runId: queued[0]!.id },
      );
      const after = yield* f.orchestrator.getThreadProjection(threadId);
      assert.strictEqual(after.runs.length, 3);
      if (!held)
        assert.deepStrictEqual(after.runs.find((run) => run.id === queued[0]!.id)?.ralphAdmission, {
          binding,
          commandId: CommandId.make("recovery"),
          origin: "human",
        });
      assert.strictEqual(
        after.messages.some((message) => message.text === "Must not overtake humans"),
        false,
      );
      assert.deepStrictEqual(
        after.runs.find((run) => run.id === queued[0]!.id)?.modelSelection,
        queued[0]!.modelSelection,
      );
      assert.strictEqual(after.runs.find((run) => run.id === queued[1]!.id)?.status, "queued");
      assert.strictEqual(after.runs.find((run) => run.id === queued[1]!.id)?.queueHeld, true);
      const sql = yield* SqlClient.SqlClient;
      const effects = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE command_id = 'recovery' AND effect_type = 'provider-turn.start'`;
      assert.strictEqual(effects[0]?.count, held ? 0 : 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("active quiet work defers admission without a second native run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* admittedRun(f);
    assert.deepStrictEqual(
      yield* f.control("quiet", { kind: "admit", text: "Never compete", recovery: true }),
      { kind: "deferred" },
    );
    assert.strictEqual((yield* f.orchestrator.getThreadProjection(threadId)).runs.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("file-backed native restart retains receipt, outcome and retired admission", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ralph-disk-" });
    const database = SqlitePersistence.layerFromPath(`${directory}/native.sqlite`);
    const disk = makeLayer(database);
    let runId = RunId.make("unassigned");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const run = yield* admittedRun(f);
        runId = run.id;
        yield* complete(f.sink, run, "RALPHCOMPLETE", "disk-final");
        yield* f.control("disk-cancel", {
          kind: "retire",
          decisions: [{ eventId: EventId.make("disk-final"), disposition: "released" }],
        });
      }).pipe(Effect.provide(disk)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.deepStrictEqual(
          yield* orchestrator.getRalphCommandReceipt(binding.ownerId, CommandId.make("admit")),
          { kind: "receipt", receipt: { kind: "admitted", origin: "ralph", runId } },
        );
        assert.deepStrictEqual(
          yield* orchestrator.getRalphCommandReceipt(
            binding.ownerId,
            CommandId.make("disk-cancel"),
          ),
          { kind: "receipt", receipt: { kind: "retired" } },
        );
        assert.strictEqual(yield* projections.isRalphRetired(threadId, binding), true);
        assert.strictEqual(
          (yield* projections.getRalphOutcomeRun(threadId, "disk-final"))?.ralphOutcome
            ?.disposition,
          "released",
        );
        assert.strictEqual((yield* projections.getRalphPendingRuns(threadId)).length, 0);
        yield* orchestrator.dispatch({
          type: "ralph.control",
          commandId: CommandId.make("old-arm-after-restart"),
          threadId,
          projectId,
          binding,
          action: { kind: "arm" },
        });
        assert.deepStrictEqual(
          yield* orchestrator.getRalphCommandReceipt(
            binding.ownerId,
            CommandId.make("old-arm-after-restart"),
          ),
          { kind: "receipt", receipt: { kind: "rejected", reason: "identity-changed" } },
        );
        assert.strictEqual((yield* projections.getThreadProjection(threadId)).runs.length, 1);
      }).pipe(Effect.provide(disk)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retirement transaction consumes a completion committed after its planner read and fences stale runtime replay",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      const plannedThread = yield* f.projections.getThread(threadId);
      const now = yield* DateTime.now;
      yield* complete(f.sink, run, "still working", "racing-final");
      yield* f.sink.commitCommand({
        commandId: CommandId.make("planned-cancel"),
        threadId,
        commandType: "ralph.control",
        acceptedAt: now,
        events: [
          {
            type: "thread.metadata-updated",
            id: EventId.make("planned-cancel-event"),
            threadId,
            occurredAt: now,
            payload: {
              ...plannedThread,
              ralphBinding: null,
              ralphRetiredBinding: binding,
              ralphLastReceipt: {
                commandId: CommandId.make("planned-cancel"),
                binding,
                result: { kind: "retired" },
              },
            },
          },
        ],
        effects: [],
      });
      assert.strictEqual(
        (yield* f.projections.getRalphOutcomeRun(threadId, "racing-final"))?.ralphOutcome
          ?.disposition,
        "consumed",
      );
      yield* complete(f.sink, run, "RALPHCOMPLETE", "stale-final");
      assert.strictEqual((yield* f.projections.getRalphPendingRuns(threadId)).length, 0);
      const stored = (yield* f.projections.getThreadProjection(threadId)).runs[0]!.ralphOutcome;
      assert.strictEqual(stored?.eventId, "racing-final");
      assert.strictEqual(stored?.disposition, "consumed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["RALPHCOMPLETE", 5_000, "ralph-complete"],
  [" RALPHCOMPLETE", 300_000, "other"],
  ['"RALPHCOMPLETE"', 300_000, "other"],
  ["done RALPHCOMPLETE", 300_000, "other"],
  [" \n\t", 300_000, "empty"],
  ["Useful work", 299_000, "other"],
  ["Useful work", 300_000, "other"],
] as const)("captures exact native final response %s after %s ms", ([text, duration, expected]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const run = yield* admittedRun(f);
    yield* complete(f.sink, run, text, "classification", duration);
    const outcome = (yield* f.projections.getRalphOutcomeRun(threadId, "classification"))
      ?.ralphOutcome;
    assert.strictEqual(outcome?.finalResponse, expected);
    assert.strictEqual(outcome?.workDurationMs, duration);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "accepted native Stop retires admission without losing a supervisor decision awaiting settlement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      yield* complete(f.sink, run, "RALPHCOMPLETE", "stop-final");
      yield* f.orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("native-stop"),
        threadId,
      });
      const snapshot = yield* f.orchestrator.getRalphSnapshot(binding.ownerId);
      const facts = snapshot.threads.find((entry) => entry.thread.id === threadId)!;
      assert.strictEqual(facts.thread.ralphBinding, null);
      assert.deepStrictEqual(facts.thread.ralphRetiredBinding, binding);
      assert.strictEqual(facts.outcomes[0]?.disposition, "pending");
      assert.deepStrictEqual(yield* f.control("late-arm-after-stop", { kind: "arm" }), {
        kind: "rejected",
        reason: "identity-changed",
      });
      yield* f.control("ordered-retire-after-stop", {
        kind: "retire",
        decisions: [{ eventId: EventId.make("stop-final"), disposition: "released" }],
      });
      assert.strictEqual(
        (yield* f.projections.getRalphOutcomeRun(threadId, "stop-final"))?.ralphOutcome
          ?.disposition,
        "released",
      );
      assert.strictEqual((yield* f.projections.getRalphPendingRuns(threadId)).length, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "streaming",
  "subagent",
  "tool",
  "old-run",
  "incomplete-root",
  "later-response",
] as const)("does not finish from a %s RALPHCOMPLETE match", (variant) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const run = yield* admittedRun(f);
    yield* complete(f.sink, run, "RALPHCOMPLETE", "decoy", 5_000, (events) => {
      if (variant === "later-response") {
        const copies = events.flatMap<OrchestrationV2DomainEvent>((event) => {
          if (event.type === "node.updated" && event.payload.kind === "assistant_message")
            return [
              {
                ...event,
                id: EventId.make("later-node-event"),
                payload: { ...event.payload, id: NodeId.make("later-node") },
              },
            ];
          if (event.type === "message.updated")
            return [
              {
                ...event,
                id: EventId.make("later-message-event"),
                payload: {
                  ...event.payload,
                  id: MessageId.make("later-message"),
                  nodeId: NodeId.make("later-node"),
                  text: "Continuing",
                },
              },
            ];
          if (event.type === "turn-item.updated" && event.payload.type === "assistant_message")
            return [
              {
                ...event,
                id: EventId.make("later-item-event"),
                payload: {
                  ...event.payload,
                  id: TurnItemId.make("later-item"),
                  nodeId: NodeId.make("later-node"),
                  messageId: MessageId.make("later-message"),
                  text: "Continuing",
                  ordinal: 2,
                },
              },
            ];
          return [];
        });
        return [...events, ...copies];
      }
      return events.map((event) => {
        if (
          variant === "incomplete-root" &&
          event.type === "node.updated" &&
          event.payload.kind === "root_turn"
        )
          return { ...event, payload: { ...event.payload, status: "failed" } };
        if (
          variant === "tool" &&
          event.type === "node.updated" &&
          event.payload.kind === "assistant_message"
        )
          return { ...event, payload: { ...event.payload, kind: "tool_call" } };
        if (
          variant === "subagent" &&
          event.type === "node.updated" &&
          event.payload.kind === "assistant_message"
        )
          return {
            ...event,
            payload: { ...event.payload, parentNodeId: NodeId.make("child-root") },
          };
        if (variant === "streaming" && event.type === "message.updated")
          return { ...event, payload: { ...event.payload, streaming: true } };
        if (variant === "old-run" && event.type === "message.updated")
          return { ...event, payload: { ...event.payload, runId: RunId.make("old-run") } };
        return event;
      });
    });
    assert.notStrictEqual(
      (yield* f.projections.getRalphOutcomeRun(threadId, "decoy"))?.ralphOutcome?.finalResponse,
      "ralph-complete",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["consumed", "released"] as const)(
  "Stop preserves a committed %s decision through rollback, reopen and lost retirement acknowledgement",
  (disposition) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ralph-stop-crash-" });
      const disk = makeLayer(SqlitePersistence.layerFromPath(`${directory}/native.sqlite`));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const run = yield* admittedRun(f);
          yield* complete(f.sink, run, "RALPHCOMPLETE", "committed-decision");
          yield* f.orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-before-disposition"),
            threadId,
          });
          assert.strictEqual(
            (yield* f.projections.getRalphOutcomeRun(threadId, "committed-decision"))?.ralphOutcome
              ?.disposition,
            "pending",
          );
          const sql = yield* SqlClient.SqlClient;
          // Force a real SQLite transaction rollback after the receipt reservation.
          yield* sql`CREATE TRIGGER fail_ralph_retirement BEFORE UPDATE ON orchestration_command_receipts
      WHEN NEW.command_id = 'ordered-retirement' BEGIN SELECT RAISE(ABORT, 'injected retirement rollback'); END`;
          const failed = yield* Effect.exit(
            f.control("ordered-retirement", {
              kind: "retire",
              decisions: [{ eventId: EventId.make("committed-decision"), disposition }],
            }),
          );
          assert.strictEqual(failed._tag, "Failure");
          assert.strictEqual(
            (yield* f.projections.getRalphOutcomeRun(threadId, "committed-decision"))?.ralphOutcome
              ?.disposition,
            "pending",
          );
          assert.deepStrictEqual(
            yield* f.orchestrator.getRalphCommandReceipt(
              binding.ownerId,
              CommandId.make("ordered-retirement"),
            ),
            { kind: "absent" },
          );
          yield* sql`DROP TRIGGER fail_ralph_retirement`;
        }).pipe(Effect.provide(disk)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const command = {
            type: "ralph.control" as const,
            commandId: CommandId.make("ordered-retirement"),
            threadId,
            projectId,
            binding,
            action: {
              kind: "retire" as const,
              decisions: [{ eventId: EventId.make("committed-decision"), disposition }],
            },
          };
          yield* orchestrator.dispatch(command);
          // Replay the same command after an acknowledgement loss; no second event or changed disposition.
          const replay = yield* orchestrator.dispatch(command);
          assert.strictEqual(replay.replayed, true);
          yield* orchestrator.dispatch({
            ...command,
            commandId: CommandId.make("late-resolution"),
            action: {
              kind: "resolve",
              eventId: EventId.make("committed-decision"),
              disposition: disposition === "released" ? "consumed" : "released",
            },
          });
          assert.strictEqual(
            (yield* projections.getRalphOutcomeRun(threadId, "committed-decision"))?.ralphOutcome
              ?.disposition,
            disposition,
          );
          assert.strictEqual((yield* projections.getRalphPendingRuns(threadId)).length, 0);
          assert.deepStrictEqual(
            yield* orchestrator.getRalphCommandReceipt(
              binding.ownerId,
              CommandId.make("ordered-retirement"),
            ),
            { kind: "receipt", receipt: { kind: "retired" } },
          );
        }).pipe(Effect.provide(disk)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
