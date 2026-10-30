import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  ProviderThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  projectThreadAwarenessV2,
  ralphTerminalNotification,
} from "@t3tools/shared/agentAwareness";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  fixture,
  makeLayer,
  binding,
  layerTest,
  admittedRun,
  complete,
  threadId,
  projectId,
} from "./testkit/RalphHarness.ts";
import { classifyRalphWork } from "./RalphWork.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";

it.effect.each(["", "quick answer", "RALPHCOMPLETE"])(
  "two unheld humans do not drain after recovery outcome %s; one due retry preserves order",
  (text) =>
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
      yield* complete(f.sink, source, "", "initial-empty", 1_000);
      yield* f.orchestrator.resumeQueuedRuns;
      let runs = (yield* f.orchestrator.getThreadProjection(threadId)).runs;
      assert.strictEqual(runs.filter((run) => run.status === "queued").length, 2);
      const first = yield* f.control("due-first", {
        kind: "admit",
        text: "Do not overtake",
        recovery: true,
      });
      assert.strictEqual(first.kind, "admitted");
      if (first.kind !== "admitted") return;
      const human = (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === first.runId,
      )!;
      assert.strictEqual(human.userMessageId, "human-first");
      yield* complete(f.sink, human, text, "human-empty-fast", 1_000);
      yield* f.orchestrator.resumeQueuedRuns;
      runs = (yield* f.orchestrator.getThreadProjection(threadId)).runs;
      assert.strictEqual(
        runs.find((run) => run.userMessageId === "human-second")?.status,
        "queued",
      );
      const second = yield* f.control("due-second", {
        kind: "admit",
        text: "Do not overtake",
        recovery: true,
      });
      assert.strictEqual(second.kind, "admitted");
      if (second.kind !== "admitted") return;
      assert.strictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === second.runId,
        )?.userMessageId,
        "human-second",
      );
      assert.strictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).messages.some(
          (message) => message.text === "Do not overtake",
        ),
        false,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["manual", "useful", "exact", "ordinary"])(
  "queue recovery retains %s native behavior",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = yield* admittedRun(f);
      yield* f.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human"),
        messageId: MessageId.make("human"),
        threadId,
        text: "human",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "ordinary") yield* f.control("cancel", { kind: "retire", decisions: [] });
      yield* complete(
        f.sink,
        source,
        scenario === "exact" ? "RALPHCOMPLETE" : scenario === "useful" ? "useful answer" : "",
        "terminal",
        scenario === "useful" ? 300_000 : 1_000,
      );
      if (scenario === "manual")
        yield* f.orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("manual-resume"),
          threadId,
        });
      else yield* f.orchestrator.resumeQueuedRuns;
      assert.notStrictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === "human",
        )?.status,
        "queued",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "released final A remains visible behind consumed human B through canonical/SQL shell and awareness",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* admittedRun(f);
      yield* f.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-B"),
        messageId: MessageId.make("human-B"),
        threadId,
        text: "Human B",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* complete(f.sink, a, "RALPHCOMPLETE", "final-A", 1_000);
      yield* f.orchestrator.resumeQueuedRuns;
      const b = (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === "human-B",
      )!;
      yield* complete(f.sink, b, "quick human result", "final-B", 1_000);
      yield* f.control("ordered-final-retire", {
        kind: "retire",
        decisions: [{ eventId: EventId.make("final-A"), disposition: "released" }],
      });
      const shell = (yield* f.projections.getThreadShell(threadId))!;
      assert.strictEqual(shell.latestRunId, b.id);
      assert.strictEqual(shell.ralphOutcome?.disposition, "consumed");
      assert.strictEqual(shell.ralphReleasedOutcome?.runId, a.id);
      assert.strictEqual(shell.ralphReleasedOutcome?.eventId, "final-A");
      const canonical = (yield* f.projections.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepStrictEqual(canonical.ralphReleasedOutcome, shell.ralphReleasedOutcome);
      const awareness = projectThreadAwarenessV2({
        environmentId: "env" as never,
        project: { title: "Project" },
        thread: shell,
      });
      assert.strictEqual(awareness?.phase, "completed");
      assert.strictEqual(
        awareness?.updatedAt,
        DateTime.formatIso(DateTime.makeUnsafe(shell.ralphReleasedOutcome!.occurredAt)),
      );
      assert.strictEqual(ralphTerminalNotification({ ...shell, ralphNotification: null }), null);
    }).pipe(Effect.provide(layerTest)),
);

it.each([
  [{ taskId: "awaited-command", kind: "command", awaited: true }, true, false],
  [{ taskId: "unawaited-command", kind: "command" }, false, false],
  [{ taskId: "monitor", kind: "monitor" }, false, true],
  [{ taskId: "subagent", kind: "subagent" }, true, false],
  [{ taskId: "background", kind: "background_task" }, true, false],
] as const)("native classifier owns %s work holds", (task, executing, eventWait) => {
  const shell = {
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingQuestions: [],
    pendingBackgroundTasks: [task],
  } as unknown as OrchestrationV2ThreadShell;
  assert.deepStrictEqual(classifyRalphWork(shell, false), {
    executing,
    eventWait,
    inputPending: false,
  });
  assert.strictEqual(classifyRalphWork(shell, true).eventWait, true);
  assert.strictEqual(
    classifyRalphWork({ ...shell, pendingQuestions: [{}] as never }, false).inputPending,
    true,
  );
});

it.effect.each([
  [{ kind: "command", taskId: "awaited", awaited: true }, true, false],
  [{ kind: "command", taskId: "unawaited" }, false, false],
  [{ kind: "monitor", taskId: "monitor" }, false, true],
  [{ kind: "subagent", taskId: "child" }, true, false],
] as const)(
  "snapshot and fresh admission share native work owner for %s",
  ([task, executing, eventWait]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      yield* complete(f.sink, run, "useful result", "work-source");
      yield* f.control("consume-work-source", {
        kind: "resolve",
        eventId: EventId.make("work-source"),
        disposition: "consumed",
      });
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          {
            type: "provider-thread.updated",
            id: EventId.make("native-work"),
            threadId,
            occurredAt: now,
            payload: {
              id: ProviderThreadId.make("native-owner"),
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [task],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      const snapshot = yield* f.orchestrator.getRalphSnapshot(binding.ownerId);
      assert.deepStrictEqual(snapshot.threads.find((value) => value.thread.id === threadId)!.work, {
        executing,
        eventWait,
        inputPending: false,
      });
      assert.strictEqual(yield* f.projections.isRalphWorkBlocked(threadId), executing || eventWait);
      const receipt = yield* f.control("fresh-work-admit", {
        kind: "admit",
        text: "continue",
        recovery: false,
      });
      assert.strictEqual(receipt.kind, executing || eventWait ? "deferred" : "admitted");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "released A and consumed B retain exact event/time through native file close/reopen",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ralph-notification-restart-" });
      const disk = makeLayer(SqlitePersistence.layerFromPath(`${root}/native.sqlite`));
      const released = yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const a = yield* admittedRun(f);
          yield* f.orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restart-human-B"),
            messageId: MessageId.make("restart-human-B"),
            threadId,
            text: "Human B",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* complete(f.sink, a, "RALPHCOMPLETE", "restart-final-A", 1_000);
          yield* f.orchestrator.resumeQueuedRuns;
          const b = (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === "restart-human-B",
          )!;
          yield* complete(f.sink, b, "fast B", "restart-final-B", 1_000);
          yield* f.control("restart-retire", {
            kind: "retire",
            decisions: [{ eventId: EventId.make("restart-final-A"), disposition: "released" }],
          });
          return (yield* f.projections.getThreadShell(threadId))!.ralphReleasedOutcome;
        }).pipe(Effect.provide(disk)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          for (let reconnect = 0; reconnect < 2; reconnect++) {
            const shell = (yield* store.getThreadShell(threadId))!;
            assert.deepStrictEqual(ralphTerminalNotification(shell), {
              kind: "released",
              eventId: released!.eventId,
              runId: released!.runId,
              occurredAt: released!.occurredAt,
              recovery: released!.recovery,
            });
            assert.strictEqual(shell.ralphOutcome?.disposition, "consumed");
            assert.strictEqual((yield* store.getRalphPendingRuns(threadId)).length, 0);
          }
        }).pipe(Effect.provide(disk)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["", "quick ordinary B", "RALPHCOMPLETE"])(
  "ordinary promoted B allows C after %s despite enrolled loop",
  (text) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* admittedRun(f);
      for (const id of ["ordinary-B", "ordinary-C"])
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
      yield* complete(f.sink, a, "useful automatic result", "useful-auto", 300_000);
      yield* f.orchestrator.resumeQueuedRuns;
      const b = (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === "ordinary-B",
      )!;
      assert.strictEqual(b.ralphAdmission, undefined);
      yield* complete(f.sink, b, text, "ordinary-B-result", 1_000);
      yield* f.orchestrator.resumeQueuedRuns;
      assert.notStrictEqual(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === "ordinary-C",
        )?.status,
        "queued",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("canonical and SQL shells keep a new binding quiet behind prior released A", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const a = yield* admittedRun(f);
    yield* complete(f.sink, a, "RALPHCOMPLETE", "old-binding-final", 1_000);
    yield* f.control("old-retire", {
      kind: "retire",
      decisions: [{ eventId: EventId.make("old-binding-final"), disposition: "released" }],
    });
    const next = { ...binding, loopId: "new-loop" };
    yield* f.control("new-arm", { kind: "arm" }, next);
    const receipt = yield* f.control(
      "new-admit",
      { kind: "admit", text: "new loop", recovery: false },
      next,
    );
    assert.strictEqual(receipt.kind, "admitted");
    if (receipt.kind !== "admitted") return;
    const b = (yield* f.orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.id === receipt.runId,
    )!;
    yield* complete(f.sink, b, "fast new intermediate", "new-binding-intermediate", 1_000);
    yield* f.control(
      "new-consume",
      {
        kind: "resolve",
        eventId: EventId.make("new-binding-intermediate"),
        disposition: "consumed",
      },
      next,
    );
    const sql = (yield* f.projections.getThreadShell(threadId))!;
    const canonical = (yield* f.projections.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    )!;
    for (const shell of [sql, canonical]) {
      assert.strictEqual(shell.ralphReleasedOutcome?.eventId, "old-binding-final");
      assert.deepStrictEqual(shell.ralphNotification, { kind: "quiet" });
      assert.strictEqual(
        projectThreadAwarenessV2({
          environmentId: "env" as never,
          project: { title: "Project" },
          thread: shell,
        }),
        null,
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["preparing", "starting", "running", "waiting"] as const)(
  "fresh admission preserves native active %s work including provider retry waits",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("active-native-guard"),
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status, completedAt: null },
          },
        ],
      });
      const snapshot = yield* f.orchestrator.getRalphSnapshot(binding.ownerId);
      assert.strictEqual(
        snapshot.threads.find((value) => value.thread.id === threadId)!.work.executing,
        true,
      );
      assert.deepStrictEqual(
        yield* f.control("blocked-native-retry", {
          kind: "admit",
          text: "Never compete with native retry",
          recovery: true,
        }),
        { kind: "deferred" },
      );
      assert.strictEqual((yield* f.orchestrator.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "fresh admission and snapshot read current enabled schedule state without a shell event",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.control("scheduled-arm", { kind: "arm" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,
    model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
    VALUES ('ralph-guard-schedule','Guard','Later',1,'{"type":"interval","everyMs":86400000}',${projectId},${threadId},
    '{"type":"root"}','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','user','web',
    '2026-10-30T00:00:00Z','2026-10-30T00:00:00Z','never',0)`;
      let facts = (yield* f.orchestrator.getRalphSnapshot(binding.ownerId)).threads.find(
        (value) => value.thread.id === threadId,
      )!;
      assert.strictEqual(facts.work.eventWait, true);
      assert.deepStrictEqual(
        yield* f.control("enabled-schedule-blocks", {
          kind: "admit",
          text: "Do not overtake schedule",
          recovery: false,
        }),
        { kind: "deferred" },
      );
      yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'ralph-guard-schedule'`;
      facts = (yield* f.orchestrator.getRalphSnapshot(binding.ownerId)).threads.find(
        (value) => value.thread.id === threadId,
      )!;
      assert.strictEqual(facts.work.eventWait, false);
      assert.strictEqual(
        (yield* f.control("disabled-schedule-releases", {
          kind: "admit",
          text: "Continue",
          recovery: false,
        })).kind,
        "admitted",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pending native input independently prevents fresh admission after completed root work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const run = yield* admittedRun(f);
      yield* complete(f.sink, run, "Useful work", "input-guard-source");
      yield* f.control("consume-input-source", {
        kind: "resolve",
        eventId: EventId.make("input-guard-source"),
        disposition: "consumed",
      });
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          {
            type: "runtime-request.updated",
            id: EventId.make("pending-input-guard"),
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("ralph-pending-question"),
              nodeId: run.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const facts = (yield* f.orchestrator.getRalphSnapshot(binding.ownerId)).threads.find(
        (value) => value.thread.id === threadId,
      )!;
      assert.strictEqual(facts.work.inputPending, true);
      assert.deepStrictEqual(
        yield* f.control("pending-input-blocks", {
          kind: "admit",
          text: "Do not answer for the owner",
          recovery: true,
        }),
        { kind: "deferred" },
      );
      assert.strictEqual((yield* f.orchestrator.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(layerTest)),
);
