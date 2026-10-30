import type {
  OrchestrationV2RalphNotification,
  OrchestrationV2RalphOutcome,
  RunId,
} from "@t3tools/contracts";
import { sameRalphBinding } from "./RalphOutcomes.ts";

/** Single native selection owner, shared by canonical and SQL shell projections. */
export function selectRalphNotification(
  latestRunId: RunId | null,
  current: OrchestrationV2RalphOutcome | null | undefined,
  released: OrchestrationV2RalphOutcome | null | undefined,
): OrchestrationV2RalphNotification | null {
  if (current == null || current.runId !== latestRunId) return null;
  const selected =
    current.disposition === "released"
      ? current
      : released?.disposition === "released" && sameRalphBinding(released.binding, current.binding)
        ? released
        : null;
  return selected === null
    ? { kind: "quiet" }
    : {
        kind: "released",
        eventId: selected.eventId,
        runId: selected.runId,
        occurredAt: selected.occurredAt,
        recovery: selected.recovery,
      };
}
