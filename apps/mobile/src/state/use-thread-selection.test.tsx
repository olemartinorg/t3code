import { createElement } from "react";
import { renderToString } from "react-dom/server";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ projection: {} as Record<string, unknown> }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@react-navigation/native", () => ({
  useRoute: () => ({ params: { environmentId: "environment-1", threadId: "thread-1" } }),
}));
vi.mock("@t3tools/client-runtime/state/shell", () => ({
  presentThreadShell: (environmentId: string, shell: object) => ({ environmentId, ...shell }),
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveLatestThreadRun: () => null,
  deriveThreadRuntime: () => null,
}));
vi.mock("./entities", () => ({ useProject: () => null, useThreadShell: () => null }));
vi.mock("./threads", () => ({
  useEnvironmentThread: () => ({ data: Option.some(fixture.projection) }),
}));
vi.mock("./pending-thread-creation", () => ({
  pendingThreadCreationOutcomesAtom: {},
  pendingThreadCreationShell: vi.fn(),
  resolvePendingThreadCreation: () => null,
}));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => null,
  useSavedRemoteConnection: () => null,
}));
vi.mock("./use-thread-outbox", () => ({ useThreadOutboxMessages: () => ({}) }));

import { useThreadSelection } from "./use-thread-selection";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "opens a thread from detail before its shell arrives without Hermes' missing toSorted (questions: %s)",
  (hasQuestions) => {
    const createdAt = DateTime.makeUnsafe("2026-10-15T12:00:00Z");
    const later = DateTime.makeUnsafe("2026-10-15T12:01:00Z");
    const request = (id: string, at = createdAt) => ({
      id,
      kind: "user_input",
      status: "pending",
      createdAt: at,
      responseCapability: { type: "live" },
    });
    const requests = hasQuestions
      ? [request("later", later), request("first-b"), request("first-a"), request("hidden")]
      : [];
    fixture.projection = {
      thread: { id: "thread-1", projectId: "project-1", title: "A conversation" },
      messages: [],
      runtimeRequests: requests,
      turnItems: requests
        .filter(({ id }) => id !== "hidden")
        .map(({ id }) => ({ type: "user_input_request", requestId: id })),
      visibleTurnItems: [],
    };
    // Hermes lacks the copying array methods accepted by the ESNext TypeScript target.
    vi.spyOn(Array.prototype, "toSorted").mockImplementation(() => {
      throw new TypeError("Array.prototype.toSorted is unavailable on Hermes");
    });
    function Probe() {
      const selected = useThreadSelection().selectedThread;
      expect(selected).toMatchObject({
        id: "thread-1",
        environmentId: "environment-1",
        pendingQuestions: hasQuestions
          ? ["first-a", "first-b", "later"].map((id) => ({
              id,
              createdAt: id === "later" ? later : createdAt,
              responseCapability: "live",
            }))
          : [],
      });
      return null;
    }
    renderToString(createElement(Probe));
    expect(requests.map(({ id }) => id)).toEqual(
      hasQuestions ? ["later", "first-b", "first-a", "hidden"] : [],
    );
  },
);
