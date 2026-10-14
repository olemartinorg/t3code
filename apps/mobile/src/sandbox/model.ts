import type { SandboxApiClient } from "sandbox/client";
export type Frame = Parameters<Parameters<SandboxApiClient["connectEvents"]>[0]["onEvent"]>[0];
type Scope = Extract<Frame, { type: "state" }>["subscriptions"][number];
export type PhoneTask = Extract<
  Scope,
  { topic: "tasks"; scope: "active" }
>["data"]["tasks"][number];
export type PhoneState = {
  active: PhoneTask[];
  history: PhoneTask[];
  historyPage: Extract<Scope, { topic: "tasks"; scope: "history" }>["data"]["page"];
  github: Extract<Scope, { topic: "github" }>["data"]["github"] | null;
  pullRequestViews: Extract<Scope, { topic: "github" }>["data"]["pullRequestViews"];
  projects: Extract<Scope, { topic: "projects" }>["data"] | null;
  operations: Extract<Scope, { topic: "operations" }>["data"];
};
export const emptyPhoneState = (): PhoneState => ({
  active: [],
  history: [],
  historyPage: null,
  github: null,
  pullRequestViews: {},
  projects: null,
  operations: [],
});
/** Shared SDK has validated the whole frame; one replacement applies its entire admitted batch. */
export function applyPhoneFrame(current: PhoneState, frame: Frame): PhoneState {
  if (frame.type !== "state") return current;
  const next = { ...current };
  for (const scope of frame.subscriptions) {
    if (scope.topic === "tasks") {
      if (scope.scope === "active") next.active = scope.data.tasks;
      else {
        next.history = scope.data.tasks;
        next.historyPage = scope.data.page;
      }
    } else if (scope.topic === "github") {
      next.github = scope.data.github;
      next.pullRequestViews = scope.data.pullRequestViews;
    } else if (scope.topic === "projects") next.projects = scope.data;
    else if (scope.topic === "operations") next.operations = scope.data;
  }
  return next;
}
export function portableTaskTarget(
  task: PhoneTask,
  conversationId: string | null,
  openIntent: "open" | "new-conversation" | "settings" = "open",
): Parameters<SandboxApiClient["openT3Target"]>[0] {
  if (task.kind === "sandbox" && !task.stableId)
    throw new Error("Upgrade this task to the supported stable identity");
  return task.kind === "sandbox"
    ? { kind: "sandbox", taskId: task.id, stableId: task.stableId!, conversationId, openIntent }
    : {
        kind: "t3",
        environmentId: task.environmentId,
        projectId: task.projectId,
        conversationId,
        openIntent,
      };
}

/** Locators can rename; replacement UUIDs must never inherit a previous phone selection. */
export function samePhoneTarget(left: PhoneTask, right: PhoneTask): boolean {
  return left.kind === "sandbox"
    ? right.kind === "sandbox" && left.stableId !== null && left.stableId === right.stableId
    : right.kind === "t3" &&
        left.environmentId === right.environmentId &&
        left.projectId === right.projectId;
}

/** Opening a native view follows admitted actions, independently of live provider activity. */
export function phoneAgentAvailability(task: PhoneTask): {
  open: boolean;
  newConversation: boolean;
  settings: boolean;
} {
  const actions = task.presentation.actions.flatMap((action) =>
    action.kind === "compound" ? (action.enabled ? action.actions : []) : [action],
  );
  const enabled = (id: string) => actions.some((action) => action.id === id && action.enabled);
  if (task.kind === "t3") {
    const connected = task.connection === "connected";
    return {
      open: connected && enabled("open"),
      newConversation: connected && task.projectId !== null && enabled("new-conversation"),
      settings: connected && enabled("settings"),
    };
  }
  const open = enabled("open");
  return { open, newConversation: open, settings: open };
}
