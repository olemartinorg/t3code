import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Admission tests must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
export const makeLayer = (
  databaseLayer:
    | typeof SqlitePersistence.layerMemory
    | ReturnType<typeof SqlitePersistence.layerFromPath> = SqlitePersistence.layerMemory,
) =>
  Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name: "ralph-native" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: databaseLayer.pipe(Layer.provide(NodeServices.layer)),
        runEffectWorker: false,
      },
    ),
    EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
    ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
    databaseLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
export const layerTest = makeLayer();
export const binding = { ownerId: "test-supervisor", loopId: "loop-1", revision: 1 };
export const projectId = ProjectId.make("ralph-project");
export const threadId = ThreadId.make("ralph-thread");
type RalphAction = Extract<OrchestrationV2Command, { type: "ralph.control" }>["action"];

export const fixture = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "t3-ralph-native-",
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Ralph",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  const control = Effect.fn("RalphTest.control")(function* (
    id: string,
    action: RalphAction,
    selected = binding,
  ) {
    const result = yield* orchestrator.dispatch({
      type: "ralph.control",
      commandId: CommandId.make(id),
      threadId,
      projectId,
      binding: selected,
      action,
    });
    const event = result.storedEvents.findLast(
      (stored) =>
        stored.event.type === "thread.metadata-updated" &&
        stored.event.payload.ralphLastReceipt?.commandId === id,
    )?.event;
    assert.strictEqual(event?.type, "thread.metadata-updated");
    if (event?.type !== "thread.metadata-updated")
      throw new Error("Missing durable Ralph receipt event");
    return event.payload.ralphLastReceipt!.result;
  });
  return { orchestrator, sink, projections, control };
});

export const complete = Effect.fn("RalphTest.complete")(function* (
  sink: EventSink.EventSinkV2["Service"],
  run: OrchestrationV2Run,
  text: string,
  id = "complete",
  duration = 300_000,
  transform: (events: OrchestrationV2DomainEvent[]) => OrchestrationV2DomainEvent[] = (events) =>
    events,
) {
  const end = DateTime.makeUnsafe("2026-10-30T02:00:00Z");
  const start = DateTime.makeUnsafe(DateTime.toEpochMillis(end) - duration);
  const root = run.rootNodeId!;
  const nodeId = NodeId.make(`${id}:assistant`);
  const events: OrchestrationV2DomainEvent[] = [
    {
      type: "node.updated",
      id: EventId.make(`${id}:root`),
      threadId,
      runId: run.id,
      occurredAt: end,
      payload: {
        id: root,
        threadId,
        runId: run.id,
        parentNodeId: null,
        rootNodeId: root,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: start,
        completedAt: end,
      },
    },
    {
      type: "node.updated",
      id: EventId.make(`${id}:node`),
      threadId,
      runId: run.id,
      occurredAt: end,
      payload: {
        id: nodeId,
        threadId,
        runId: run.id,
        parentNodeId: root,
        rootNodeId: root,
        kind: "assistant_message",
        status: "completed",
        countsForRun: false,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: start,
        completedAt: end,
      },
    },
    {
      type: "message.updated",
      id: EventId.make(`${id}:message`),
      threadId,
      runId: run.id,
      occurredAt: end,
      payload: {
        id: MessageId.make(`${id}:message`),
        threadId,
        runId: run.id,
        nodeId,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: end,
        updatedAt: end,
      },
    },
    {
      type: "turn-item.updated",
      id: EventId.make(`${id}:item-event`),
      threadId,
      runId: run.id,
      occurredAt: end,
      payload: {
        id: TurnItemId.make(`${id}:item`),
        type: "assistant_message",
        threadId,
        runId: run.id,
        nodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Assistant",
        startedAt: start,
        completedAt: end,
        updatedAt: end,
        messageId: MessageId.make(`${id}:message`),
        text,
        streaming: false,
      },
    },
    {
      type: "run.updated",
      id: EventId.make(id),
      threadId,
      runId: run.id,
      occurredAt: end,
      payload: {
        ...run,
        workStartedAt: start,
        startedAt: start,
        status: "completed",
        completedAt: end,
      },
    },
  ];
  return yield* sink.write({ events: transform(events) });
});

export const admittedRun = Effect.fn("RalphTest.admittedRun")(function* (
  f: Effect.Success<typeof fixture>,
) {
  yield* f.control("arm", { kind: "arm" });
  const receipt = yield* f.control("admit", { kind: "admit", text: "Continue", recovery: false });
  assert.strictEqual(receipt.kind, "admitted");
  return (yield* f.orchestrator.getThreadProjection(threadId)).runs[0]!;
});
