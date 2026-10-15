import { ProjectId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { startComposerDraftPresencePublisher } from "./composerDraftPresencePublisher";

afterEach(() => vi.useRealTimers());
const entries = [{ projectId: ProjectId.make("project"), draftId: "local" }];

it("coalesces unchanged presence and publishes the current complete replacement", async () => {
  vi.useFakeTimers();
  let current = entries;
  const replace = vi.fn(async () => {});
  const publisher = startComposerDraftPresencePublisher({
    open: async () => 1,
    entries: () => current,
    replace,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(replace).toHaveBeenLastCalledWith(1, 1, entries);
  for (let n = 0; n < 100; n++) publisher.changed();
  await vi.advanceTimersByTimeAsync(250);
  expect(replace).toHaveBeenCalledTimes(1);
  current = [];
  publisher.changed();
  await vi.advanceTimersByTimeAsync(250);
  expect(replace).toHaveBeenLastCalledWith(1, 2, []);
  publisher.stop();
});

it("retains the accepted report on save or publish failure, backs off, and retries current facts", async () => {
  vi.useFakeTimers();
  let failedSave = true,
    current = entries;
  const open = vi.fn(async () => 2);
  const replace = vi.fn(async () => {});
  const publisher = startComposerDraftPresencePublisher({
    open,
    entries: () => {
      if (failedSave) throw new Error("save failed");
      return current;
    },
    replace,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(replace).not.toHaveBeenCalled();
  failedSave = false;
  await vi.advanceTimersByTimeAsync(1_999);
  expect(replace).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(replace).toHaveBeenCalledWith(2, 1, entries);
  replace.mockRejectedValueOnce(new Error("disconnected"));
  current = [];
  publisher.changed();
  await vi.advanceTimersByTimeAsync(250);
  current = entries;
  await vi.advanceTimersByTimeAsync(2_000);
  // The server might have accepted the failed request before disconnecting.
  expect(replace).toHaveBeenLastCalledWith(2, 1, entries);
  publisher.stop();
});

it("does not replace anything after an old connection closes during source admission", async () => {
  vi.useFakeTimers();
  let release!: (epoch: number) => void;
  const replace = vi.fn(async () => {});
  const publisher = startComposerDraftPresencePublisher({
    open: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    entries: () => entries,
    replace,
  });
  await vi.advanceTimersByTimeAsync(0);
  publisher.stop();
  release(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(replace).not.toHaveBeenCalled();
});
