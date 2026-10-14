import { expect, test } from "vite-plus/test";
import {
  applyPhoneFrame,
  phoneAgentAvailability,
  emptyPhoneState,
  portableTaskTarget,
  samePhoneTarget,
  type PhoneTask,
  type Frame,
} from "./model";
const managed = {
  kind: "sandbox",
  stableId: "11111111-1111-4111-8111-111111111111",
  id: "before",
  name: "Before",
} as PhoneTask;
test("phone target survives rename but rejects a same-name replacement and unsupported unstable records", () => {
  expect(
    samePhoneTarget(managed, { ...managed, id: "renamed", name: "Renamed" } as PhoneTask),
  ).toBe(true);
  expect(
    samePhoneTarget(managed, {
      ...managed,
      stableId: "22222222-2222-4222-8222-222222222222",
    } as PhoneTask),
  ).toBe(false);
  expect(() => portableTaskTarget({ ...managed, stableId: null } as PhoneTask, null)).toThrow(
    "stable identity",
  );
  expect(portableTaskTarget(managed, null, "new-conversation")).toMatchObject({
    stableId: managed.stableId,
    conversationId: null,
    openIntent: "new-conversation",
  });
});
test("external projectless conversations keep native target identity without a container locator", () => {
  const task = {
    kind: "t3",
    environmentId: "33333333-3333-4333-8333-333333333333",
    projectId: null,
  } as PhoneTask;
  expect(portableTaskTarget(task, "native-thread")).toEqual({
    kind: "t3",
    environmentId: task.kind === "t3" ? task.environmentId : "",
    projectId: null,
    conversationId: "native-thread",
    openIntent: "open",
  });
  expect(samePhoneTarget(task, { ...task, projectId: "another-project" } as PhoneTask)).toBe(false);
});
test("one admitted owner batch replaces included scopes together and retains omitted valid state", () => {
  const previous = {
    ...emptyPhoneState(),
    active: [managed],
    github: { prs: [], error: "last known upstream error", refreshing: false },
  };
  const frame = {
    type: "state",
    version: 3,
    serverId: "11111111-1111-4111-8111-111111111111",
    bootId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    generation: 0,
    subscriptions: [
      { topic: "tasks", scope: "active", revision: 2, data: { tasks: [] } },
      { topic: "operations", revision: 2, data: [] },
    ],
  } as Frame;
  const next = applyPhoneFrame(previous, frame);
  expect(next.active).toEqual([]);
  expect(next.operations).toEqual([]);
  expect(next.github).toBe(previous.github);
  expect(previous.active).toEqual([managed]);
});

test("PR facts and supplied relationships/visibility replace together without resetting omitted scopes", () => {
  const previous = emptyPhoneState();
  const views = { pr: { taskNames: ["Existing task"], subtitle: "Open", visibility: null } };
  const github = {
    prs: [{ id: "pr", url: "https://github.com/owner/repo/pull/1" }],
    error: null,
    refreshing: false,
  };
  const frame = {
    type: "state",
    subscriptions: [{ topic: "github", data: { github, pullRequestViews: views } }],
  } as unknown as Frame;
  const next = applyPhoneFrame(previous, frame);
  expect(next.github).toBe(github);
  expect(next.pullRequestViews).toBe(views);
  expect(next.active).toBe(previous.active);
  expect(
    applyPhoneFrame(next, { type: "state", subscriptions: [] } as unknown as Frame)
      .pullRequestViews,
  ).toBe(views);
});

test("idle connected native projects retain Open/New/Settings while unavailable and projectless targets keep their restrictions", () => {
  const task = {
    kind: "t3",
    connection: "connected",
    projectId: "native-project",
    presentation: {
      running: false,
      actions: [
        { kind: "action", id: "open", enabled: true },
        { kind: "action", id: "new-conversation", enabled: true },
        { kind: "action", id: "settings", enabled: true },
      ],
    },
  } as PhoneTask;
  expect(phoneAgentAvailability(task)).toEqual({
    open: true,
    newConversation: true,
    settings: true,
  });
  expect(phoneAgentAvailability({ ...task, connection: "disconnected" } as PhoneTask)).toEqual({
    open: false,
    newConversation: false,
    settings: false,
  });
  expect(phoneAgentAvailability({ ...task, projectId: null } as PhoneTask)).toEqual({
    open: true,
    newConversation: false,
    settings: true,
  });
  expect(
    phoneAgentAvailability({
      ...task,
      presentation: { ...task.presentation, actions: [] },
    } as PhoneTask),
  ).toEqual({ open: false, newConversation: false, settings: false });
  expect(
    phoneAgentAvailability({
      ...task,
      kind: "sandbox",
      presentation: {
        ...task.presentation,
        actions: [{ kind: "action", id: "start", enabled: true }],
      },
    } as unknown as PhoneTask),
  ).toEqual({ open: false, newConversation: false, settings: false });
});
