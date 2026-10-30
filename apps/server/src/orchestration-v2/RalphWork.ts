import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/** Native admission facts, shared by getRalphSnapshot and the fresh dispatch recheck. */
export function classifyRalphWork(shell: OrchestrationV2ThreadShell, enabledSchedule: boolean) {
  const tasks = shell.pendingBackgroundTasks ?? [];
  return {
    executing:
      ["preparing", "starting", "running", "waiting"].includes(shell.status) ||
      ["preparing", "starting", "running", "waiting"].includes(shell.activityRunStatus ?? "") ||
      backgroundWorkHoldsCompletion(tasks),
    eventWait: enabledSchedule || tasks.some((task) => task.kind === "monitor"),
    inputPending: shell.pendingRuntimeRequest !== null || (shell.pendingQuestions?.length ?? 0) > 0,
  };
}
