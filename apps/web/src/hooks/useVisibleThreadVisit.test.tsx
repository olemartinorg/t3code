// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
const state = vi.hoisted(() => ({ visit: vi.fn(), localVisit: vi.fn(), connection: "connected" }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.visit }));
vi.mock("../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connection } }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (value: unknown) => unknown) =>
    select({ markThreadVisited: state.localVisit, threadLastVisitedAtById: {} }),
}));
import { useVisibleThreadVisit } from "./useVisibleThreadVisit";
let visible = false;
const listeners = new Set<() => void>();
let renderer: ReactTestRenderer | null = null;
const thread = {
  id: "thread",
  environmentId: "env",
  updatedAt: "2026-10-07T12:00:00.000Z",
  lastCompletionAt: "2026-10-07T12:00:00.000Z",
  lastVisitedAt: null,
} as unknown as EnvironmentThreadShell;
function Reader({ value }: { value: EnvironmentThreadShell }) {
  useVisibleThreadVisit(value, "env:thread");
  return null;
}
async function show(value: boolean) {
  await act(async () => {
    visible = value;
    for (const listener of listeners) listener();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.visit.mockReset();
  state.visit.mockResolvedValue(AsyncResult.success(undefined));
  state.connection = "connected";
  state.localVisit.mockReset();
  visible = false;
  window.t3Host = {
    visibility: {
      get: () => visible,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  listeners.clear();
  delete window.t3Host;
  vi.useRealTimers();
});
test("hidden startup and background activity do not dispatch a native visit", async () => {
  await act(async () => {
    renderer = create(<Reader value={thread} />);
  });
  await act(async () => {
    renderer!.update(<Reader value={{ ...thread, updatedAt: "2026-10-07T12:00:10.000Z" }} />);
    vi.advanceTimersByTime(20000);
  });
  expect(state.visit).not.toHaveBeenCalled();
  expect(state.localVisit).not.toHaveBeenCalled();
  await show(true);
  expect(state.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", visitedAt: "2026-10-07T12:00:10.000Z" },
  });
});
test("hiding cancels a queued trailing visit and showing sends the latest watermark", async () => {
  visible = true;
  await act(async () => {
    renderer = create(<Reader value={{ ...thread, lastCompletionAt: null }} />);
  });
  await act(async () =>
    renderer!.update(
      <Reader
        value={{ ...thread, lastCompletionAt: null, updatedAt: "2026-10-07T12:00:01.000Z" }}
      />,
    ),
  );
  expect(state.visit).toHaveBeenCalledTimes(1);
  await show(false);
  await act(async () => vi.advanceTimersByTime(20000));
  expect(state.visit).toHaveBeenCalledTimes(1);
  await show(true);
  expect(state.visit).toHaveBeenCalledTimes(2);
  expect(state.visit.mock.calls[1]![0].input.visitedAt).toBe("2026-10-07T12:00:01.000Z");
});
test("mark-unread stays sticky while visible, and a reopened pane visits it", async () => {
  visible = true;
  await act(async () => {
    renderer = create(<Reader value={thread} />);
  });
  await act(async () =>
    renderer!.update(<Reader value={{ ...thread, lastVisitedAt: "2026-10-07T11:59:59.999Z" }} />),
  );
  expect(state.visit).toHaveBeenCalledTimes(1);
  await show(false);
  await show(true);
  expect(state.visit).toHaveBeenCalledTimes(2);
});
test("reordered older activity cannot rewind a server visit", async () => {
  visible = true;
  await act(async () => {
    renderer = create(<Reader value={{ ...thread, lastVisitedAt: "2026-10-07T12:00:02.000Z" }} />);
  });
  expect(state.visit).not.toHaveBeenCalled();
});
test("a new independent completion visits immediately rather than waiting for the activity throttle", async () => {
  visible = true;
  await act(async () => {
    renderer = create(<Reader value={{ ...thread, lastCompletionAt: null }} />);
  });
  await act(async () =>
    renderer!.update(
      <Reader
        value={{
          ...thread,
          updatedAt: "2026-10-07T12:00:01.000Z",
          lastCompletionAt: "2026-10-07T12:00:01.000Z",
        }}
      />,
    ),
  );
  expect(state.visit).toHaveBeenCalledTimes(2);
});

test("an imported completion later than metadata is acknowledged when visible", async () => {
  visible = true;
  await act(async () => {
    renderer = create(
      <Reader value={{ ...thread, lastCompletionAt: "2026-10-07T12:00:09.000Z" }} />,
    );
  });
  expect(state.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", visitedAt: "2026-10-07T12:00:09.000Z" },
  });
});

async function connection(phase: string) {
  state.connection = phase;
  await act(async () => renderer!.update(<Reader value={{ ...thread }} />));
}

test("a visible cached shell waits for its native connected session before acknowledging", async () => {
  visible = true;
  state.connection = "connecting";
  await act(async () => {
    renderer = create(<Reader value={thread} />);
  });
  expect(state.visit).not.toHaveBeenCalled();
  await connection("connected");
  expect(state.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", visitedAt: thread.updatedAt },
  });
});

test("a failed visit can acknowledge the same watermark after native reconnect", async () => {
  visible = true;
  state.visit.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("Session not ready"))),
  );
  await act(async () => {
    renderer = create(<Reader value={thread} />);
  });
  expect(state.visit).toHaveBeenCalledTimes(1);
  await connection("reconnecting");
  expect(state.visit).toHaveBeenCalledTimes(1);
  await connection("connected");
  expect(state.visit).toHaveBeenCalledTimes(2);
  expect(state.visit.mock.calls[1]).toEqual(state.visit.mock.calls[0]);
});

test("native reconnect does not acknowledge a hidden conversation", async () => {
  state.connection = "connecting";
  await act(async () => {
    renderer = create(<Reader value={thread} />);
  });
  await connection("connected");
  await connection("reconnecting");
  await connection("connected");
  expect(state.visit).not.toHaveBeenCalled();
  await show(true);
  expect(state.visit).toHaveBeenCalledTimes(1);
});
