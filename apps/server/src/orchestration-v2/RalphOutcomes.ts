import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RalphBinding,
  OrchestrationV2RalphOutcome,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  EventId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function sameRalphBinding(
  a: OrchestrationV2RalphBinding | null | undefined,
  b: OrchestrationV2RalphBinding | null | undefined,
): boolean {
  return (
    a != null &&
    b != null &&
    a.ownerId === b.ownerId &&
    a.loopId === b.loopId &&
    a.revision === b.revision
  );
}

/** Called once at the native terminal transaction, never by shell publication or a poller. */
export function recordRalphOutcome(input: {
  readonly run: OrchestrationV2Run;
  readonly eventId: EventId;
  readonly binding: OrchestrationV2RalphBinding;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): OrchestrationV2RalphOutcome | undefined {
  const { run, binding } = input;
  if (run.ralphOutcome !== undefined) return run.ralphOutcome;
  if (
    run.completedAt === null ||
    !["completed", "failed", "interrupted", "cancelled"].includes(run.status)
  )
    return undefined;
  const root = input.nodes.find((node) => node.id === run.rootNodeId && node.kind === "root_turn");
  const rootMessages = new Set(
    input.nodes
      .filter(
        (node) =>
          node.runId === run.id &&
          node.kind === "assistant_message" &&
          node.parentNodeId === run.rootNodeId &&
          node.rootNodeId === run.rootNodeId &&
          node.status === "completed" &&
          (root?.providerTurnId == null || node.providerTurnId === root.providerTurnId),
      )
      .map((node) => node.id),
  );
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  // Native turn-item ordinal is the response order, including equal-timestamp chunks.
  // Only a completed assistant item belonging to this run's root may finish it.
  const finalItem = input.turnItems
    .filter(
      (item) =>
        item.type === "assistant_message" &&
        item.runId === run.id &&
        item.nodeId !== null &&
        rootMessages.has(item.nodeId) &&
        item.status === "completed" &&
        !item.streaming &&
        (root?.providerTurnId == null || item.providerTurnId === root.providerTurnId),
    )
    .toSorted((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0];
  const final =
    finalItem?.type === "assistant_message" ? messages.get(finalItem.messageId) : undefined;
  const text =
    final?.runId === run.id && final.role === "assistant" && !final.streaming
      ? final.text
      : undefined;
  const start = run.workStartedAt ?? run.startedAt;
  const end = root?.completedAt ?? run.completedAt;
  const workDurationMs =
    start === null ? 0 : Math.max(0, DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start));
  return {
    eventId: input.eventId,
    runId: run.id,
    binding,
    admissionCommandId: sameRalphBinding(run.ralphAdmission?.binding, binding)
      ? run.ralphAdmission!.commandId
      : null,
    occurredAt: DateTime.toEpochMillis(run.completedAt),
    finalResponse:
      text === "RALPHCOMPLETE" && run.status === "completed" && root?.status === "completed"
        ? "ralph-complete"
        : !text?.trim()
          ? "empty"
          : "other",
    workDurationMs,
    recovery: run.status !== "completed",
    disposition: "pending",
  };
}
