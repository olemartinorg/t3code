import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  configureMobileIntegration,
  mobileFetch,
  mobileIntegration,
  mobileWebSocket,
} from "./integration";
afterEach(() => {
  configureMobileIntegration({});
  vi.unstubAllGlobals();
});
test("ordinary mobile requests and sockets retain the platform's transport and protocols", async () => {
  const platformFetch = vi.fn(async () => new Response("original"));
  const socket = vi.fn();
  class PlatformSocket {
    constructor(...args: unknown[]) {
      socket(...args);
    }
  }
  vi.stubGlobal("fetch", platformFetch);
  vi.stubGlobal("WebSocket", PlatformSocket);
  expect(await (await mobileFetch("https://native.example")).text()).toBe("original");
  mobileWebSocket("wss://native.example", ["native-protocol"]);
  expect(socket).toHaveBeenCalledWith("wss://native.example", ["native-protocol"]);
  expect(() => mobileWebSocket("wss://native.example", { headers: {} })).toThrow("not supported");
  expect(mobileIntegration().threadTools).not.toBe(false);
  expect(mobileIntegration().renderHtmlAttachments).not.toBe(false);
});
test("an embedding transport owns cancellation and can be removed without changing global transports", async () => {
  const original = vi.fn(async () => new Response("original"));
  const custom = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return new Response("embedded");
  });
  vi.stubGlobal("fetch", original);
  configureMobileIntegration({ fetch: custom });
  expect(await (await mobileFetch("https://selected.example")).text()).toBe("embedded");
  const abort = new AbortController();
  abort.abort(new Error("retired"));
  await expect(mobileFetch("https://selected.example", { signal: abort.signal })).rejects.toThrow(
    "retired",
  );
  configureMobileIntegration({});
  expect(await (await mobileFetch("https://native.example")).text()).toBe("original");
  expect(globalThis.fetch).toBe(original);
});
