import { afterEach, expect, test, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  release: vi.fn(),
  connection: vi.fn(),
  token: vi.fn(),
  foreground: vi.fn(),
}));
vi.mock("sandbox/client", () => ({
  SandboxApiClient: class {
    origin: URL;
    constructor(origin: string) {
      this.origin = new URL(origin);
    }
    openT3Target = mocks.open;
    releaseT3View = mocks.release;
    t3ViewLeaseUrl = () => "wss://pc.local/api/v1/tasks/owned/views/agent/lease?leaseId=owned";
  },
}));
vi.mock("expo", () => ({
  requireNativeModule: () => ({
    setSandboxViewToken: mocks.token,
    setSandboxThreadOnScreen: mocks.foreground,
  }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createRuntimeCommand: (_runtime: unknown, options: unknown) => options,
  runAtomCommand: (_registry: unknown, _command: unknown, input: unknown) => {
    mocks.connection(input);
    return Promise.resolve({ _tag: "Success" });
  },
  squashAtomCommandFailure: () => new Error("Native connection refused"),
}));
import { closePhoneView, openPhoneView } from "./view-controller";
import { currentNativeView } from "./transport";
const host = {
  serverId: "11111111-1111-4111-8111-111111111111",
  origin: "https://pc.local",
  name: "Owned PC",
  token: "fixture-control-key",
  notifications: true,
};
const target = {
  kind: "sandbox" as const,
  taskId: "owned",
  stableId: "22222222-2222-4222-8222-222222222222",
  conversationId: "thread",
  openIntent: "open" as const,
};
const session = {
  environmentId: "33333333-3333-4333-8333-333333333333",
  viewToken: "fixture-scoped-capability",
  leaseId: "owned",
  targetKind: "managed-task" as const,
  projectId: "project",
  taskId: "owned",
  conversationId: "thread",
  openIntent: "open" as const,
};
class Socket extends EventTarget {
  static all: Socket[] = [];
  static ready = true;
  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly options: { headers: Record<string, string> },
  ) {
    super();
    Socket.all.push(this);
    if (Socket.ready) queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}
function setup() {
  Socket.all = [];
  Socket.ready = true;
  vi.stubGlobal("WebSocket", Socket);
  mocks.open.mockResolvedValue(session);
  mocks.release.mockResolvedValue(undefined);
}
afterEach(async () => {
  await closePhoneView();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
test("visible conversation owns only scoped native connection and an ordinary API lease; exit releases both", async () => {
  setup();
  const view = await openPhoneView(host, target);
  expect(currentNativeView()).toBe(view);
  expect(Socket.all[0]?.options.headers).toEqual({ authorization: "Bearer fixture-control-key" });
  expect(mocks.connection).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: session.environmentId, enabled: true }),
  );
  expect(mocks.foreground).toHaveBeenCalledWith(
    host.serverId,
    JSON.stringify({
      kind: target.kind,
      taskId: target.taskId,
      stableId: target.stableId,
      conversationId: target.conversationId,
    }),
  );
  await closePhoneView();
  expect(currentNativeView()).toBeNull();
  expect(mocks.release).toHaveBeenCalledWith(session);
  expect(mocks.connection).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});
test("stale bootstrap completion after navigation closes its newly issued capability without connecting", async () => {
  setup();
  const pending = Promise.withResolvers<typeof session>();
  mocks.open.mockReturnValue(pending.promise);
  const opening = openPhoneView(host, target);
  await Promise.resolve();
  await closePhoneView();
  pending.resolve(session);
  await expect(opening).rejects.toThrow("navigation changed");
  expect(mocks.release).toHaveBeenCalledWith(session);
  expect(mocks.connection).not.toHaveBeenCalled();
  expect(Socket.all).toHaveLength(0);
});
test("lost lease retires the native connection without starting or replacing any provider session", async () => {
  setup();
  await openPhoneView(host, target);
  Socket.all[0]!.close();
  await vi.waitFor(() => {
    expect(currentNativeView()).toBeNull();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  expect(mocks.connection).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
test("failed lease acquisition is bounded and releases the admitted view", async () => {
  setup();
  Socket.ready = false;
  vi.useFakeTimers();
  const opening = openPhoneView(host, target);
  const assertion = expect(opening).rejects.toThrow("did not open");
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  expect(currentNativeView()).toBeNull();
  expect(mocks.release).toHaveBeenCalledWith(session);
  expect(mocks.connection).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});
