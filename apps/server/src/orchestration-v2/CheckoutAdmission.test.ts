import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Checkout tests must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerTest = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "checkout-admission" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
  ),
  ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkout-admission-" });
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make("checkout-thread");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-checkout-thread"),
    threadId,
    projectId: ProjectId.make("checkout-project"),
    title: "Checkout",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  return { fs, cwd, orchestrator, sink, threadId };
});

it.effect.each(["direct", "scheduled", "delegated"] as const)(
  "holds %s native turn admission until checkout finishes",
  (source) =>
    Effect.gen(function* () {
      const { cwd, sink, threadId, orchestrator } = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commitAttempted = yield* Deferred.make<void>();
      const commandId = CommandId.make(`checkout-${source}-start`);
      const original = sink.commitCommand;
      const spy = vi
        .spyOn(sink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === commandId
            ? Deferred.succeed(commitAttempted, undefined).pipe(Effect.andThen(original(input)))
            : original(input),
        );
      yield* Effect.gen(function* () {
        const checkout = yield* sink
          .withCheckoutAdmission(
            cwd,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const start = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId,
            threadId,
            messageId: MessageId.make(`${source}-message`),
            text: "Start work",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy:
              source === "delegated" ? "agent" : source === "scheduled" ? "system" : "user",
            creationSource:
              source === "delegated" ? "mcp" : source === "scheduled" ? "server" : "web",
            ...(source === "scheduled"
              ? { scheduledTaskId: ScheduledTaskId.make("scheduled-task") }
              : {}),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(commitAttempted),
          Fiber.join(start).pipe(
            Effect.andThen(Effect.die("Native start did not reach its commit barrier")),
          ),
        );
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checkout);
        yield* Fiber.join(start);
        const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.lengthOf(runs, 1);
        assert.equal(runs[0]!.status, "starting");
        const rejected = yield* sink
          .withCheckoutAdmission(cwd, Effect.die("Busy checkout must not execute"))
          .pipe(Effect.flip);
        assert.equal(rejected.reason, "active-work");
      }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["app_owned", "provider_native"] as const)(
  "blocks %s subagent work after its root turn ends, including overlapping paths",
  (origin) =>
    Effect.gen(function* () {
      const { fs, cwd, sink, threadId } = yield* fixture;
      const path = yield* Path.Path;
      const nested = path.join(cwd, "nested");
      const sibling = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkout-sibling-" });
      yield* fs.makeDirectory(nested);
      const alias = path.join(sibling, "alias");
      yield* fs.symlink(cwd, alias);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${origin}-event`),
            type: "subagent.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: NodeId.make(`${origin}-subagent`),
              threadId,
              runId: null,
              parentNodeId: NodeId.make("parent-node"),
              origin,
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Work",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      for (const checkout of [cwd, nested, alias]) {
        const error = yield* sink.withCheckoutAdmission(checkout, Effect.void).pipe(Effect.flip);
        assert.equal(error.reason, "active-work");
      }
      yield* sink.withCheckoutAdmission(sibling, Effect.void);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("blocks provider-native pending turns and background work without a root run", () =>
  Effect.gen(function* () {
    const { cwd, sink, threadId } = yield* fixture;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("native-provider-thread");
    const turn = {
      id: ProviderTurnId.make("pending-native-turn"),
      providerThreadId,
      nodeId: NodeId.make("native-node"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("pending-native-turn-event"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: turn,
        },
      ],
    });
    assert.equal(
      (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
      "active-work",
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make("finished-native-turn-event"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: { ...turn, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("native-background-event"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
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
            pendingBackgroundTasks: [{ kind: "background_task", taskId: "native-background" }],
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    assert.equal(
      (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
      "active-work",
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("releases native admission after checkout failure and cancellation", () =>
  Effect.gen(function* () {
    const { cwd, sink } = yield* fixture;
    assert.equal(
      yield* sink.withCheckoutAdmission(cwd, Effect.fail("Git failed")).pipe(Effect.flip),
      "Git failed",
    );
    yield* sink.withCheckoutAdmission(cwd, Effect.void);
    const entered = yield* Deferred.make<void>();
    const checkout = yield* sink
      .withCheckoutAdmission(
        cwd,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(checkout);
    yield* sink.withCheckoutAdmission(cwd, Effect.void);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("blocks an already committed provider-start effect before any run is visible", () =>
  Effect.gen(function* () {
    const { cwd, sink, threadId } = yield* fixture;
    yield* sink.writeWithEffects({
      events: [],
      effects: [
        {
          id: "pending-provider-start",
          commandId: CommandId.make("pending-provider-start"),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("pending-provider-run") },
        },
      ],
    });
    assert.equal(
      (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
      "active-work",
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "blocks unknown native ownership and resolves a project's checkout when no worktree is set",
  () =>
    Effect.gen(function* () {
      const { cwd, sink, threadId, orchestrator } = yield* fixture;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("project-checkout"),
        threadId,
        worktreePath: null,
      });
      yield* sink.writeWithEffects({
        events: [],
        effects: [
          {
            id: "project-checkout-start",
            commandId: CommandId.make("project-checkout-start"),
            threadId,
            request: { type: "provider-turn.start", runId: RunId.make("project-checkout-run") },
          },
        ],
      });
      assert.equal(
        (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
        "unknown-ownership",
      );
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("checkout-project-created"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("checkout-project"),
        occurredAt: "2026-10-22T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: ProjectId.make("checkout-project"),
          title: "Checkout project",
          workspaceRoot: cwd,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:00:00.000Z",
        },
      });
      assert.equal(
        (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
        "active-work",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["defer_start", "queue_after_active"] as const)(
  "blocks existing %s native work",
  (mode) =>
    Effect.gen(function* () {
      const { cwd, sink, threadId, orchestrator } = yield* fixture;
      for (const dispatchMode of mode === "queue_after_active"
        ? (["start_immediately", mode] as const)
        : ([mode] as const)) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(dispatchMode),
          threadId,
          messageId: MessageId.make(dispatchMode),
          text: "Prepare work",
          attachments: [],
          dispatchMode: { type: dispatchMode },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(
        projection.runs.some(
          (run) => run.status === (mode === "defer_start" ? "preparing" : "queued"),
        ),
      );
      assert.equal(
        (yield* sink.withCheckoutAdmission(cwd, Effect.void).pipe(Effect.flip)).reason,
        "active-work",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
