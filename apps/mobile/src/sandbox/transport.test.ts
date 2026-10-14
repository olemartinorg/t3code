import { afterEach, expect, test, vi } from "vite-plus/test";
import { nativeT3Fetch, nativeT3Socket, setNativeView, trustedOrigin } from "./transport.ts";
vi.mock("expo", () => ({ requireNativeModule: vi.fn(() => ({ setSandboxViewToken: vi.fn() })) }));
afterEach(() => {
  setNativeView(null);
  vi.unstubAllGlobals();
});
const session = {
  environmentId: "env",
  viewToken: "owned-scoped-view",
  leaseId: "lease",
  targetKind: "managed-task" as const,
  projectId: "project",
  taskId: "owned",
  conversationId: "thread",
  openIntent: "open" as const,
};
test("native HTTP uses only active scoped capability and rejects a different origin before transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  setNativeView({ origin: "https://pc.local", generation: 1, session });
  await nativeT3Fetch("https://pc.local/api/orchestration/thread", {
    headers: { authorization: "Bearer unwanted-native-credential" },
  });
  const headers = fetcher.mock.calls[0]![1]!.headers as Headers;
  expect(headers.get("x-sandbox-view-token")).toBe("owned-scoped-view");
  expect(headers.get("authorization")).toBeNull();
  expect(fetcher.mock.calls[0]![1]!.redirect).toBe("error");
  await expect(nativeT3Fetch("https://public.example/api/private")).rejects.toThrow(
    "origin changed",
  );
  setNativeView(null);
  await expect(nativeT3Fetch("https://pc.local/api/private")).rejects.toThrow("not active");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("native socket carries scoped header without URLs or control bearer, and unbound callbacks fail", () => {
  const create = vi.fn();
  class FakeSocket {
    constructor(...args: unknown[]) {
      create(...args);
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  setNativeView({ origin: "https://pc.local", generation: 2, session });
  nativeT3Socket("wss://pc.local/ws?orchestrationProtocolVersion=2");
  expect(create).toHaveBeenCalledWith("wss://pc.local/ws?orchestrationProtocolVersion=2", [], {
    headers: { "x-sandbox-view-token": "owned-scoped-view" },
  });
  expect(() => nativeT3Socket("ws://pc.local/ws")).toThrow("origin changed");
  expect(() => nativeT3Socket("wss://public.example/ws")).toThrow("origin changed");
  setNativeView(null);
  expect(() => nativeT3Socket("wss://pc.local/ws")).toThrow("not active");
  expect(create).toHaveBeenCalledTimes(1);
});
test("control origin allows HTTP or HTTPS without embedded credentials or routing", () => {
  expect(trustedOrigin("https://pc.local:19480/")).toBe("https://pc.local:19480");
  expect(trustedOrigin("http://pc.local:19480/")).toBe("http://pc.local:19480");
  for (const origin of [
    "ftp://pc.local",
    "https://key@pc.local",
    "https://pc.local/private",
    "https://pc.local/?token=private",
  ])
    expect(() => trustedOrigin(origin)).toThrow("LAN HTTP or HTTPS");
});

test("selected HTTP uses matching WS and scoped headers without allowing a protocol switch", async () => {
  const create = vi.fn();
  class FakeSocket {
    constructor(...args: unknown[]) {
      create(...args);
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
  setNativeView({ origin: "http://pc.local:19480", generation: 3, session });
  await nativeT3Fetch("http://pc.local:19480/api/thread");
  nativeT3Socket("ws://pc.local:19480/ws");
  expect(create).toHaveBeenCalledWith("ws://pc.local:19480/ws", [], {
    headers: { "x-sandbox-view-token": "owned-scoped-view" },
  });
  expect(() => nativeT3Socket("wss://pc.local:19480/ws")).toThrow("origin changed");
  await expect(nativeT3Fetch("https://pc.local:19480/api/thread")).rejects.toThrow(
    "origin changed",
  );
});
