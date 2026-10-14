import { requireNativeModule } from "expo";
import type { SandboxApiClient } from "sandbox/client";

interface SandboxNative {
  selectSandboxHost(origin: string | null): void;
  setSandboxViewToken(token: string | null): void;
  configureSandboxNotifications(installationId: string, hosts: Record<string, boolean>): void;
  setSandboxThreadOnScreen(serverId: string | null, target: string | null): void;
}
export function nativeSandbox() {
  return requireNativeModule<SandboxNative>("T3AgentNotifications");
}
export type NativeView = {
  origin: string;
  generation: number;
  session: Awaited<ReturnType<SandboxApiClient["openT3Target"]>>;
};
let view: NativeView | null = null;
export function currentNativeView() {
  return view;
}
export function setNativeView(value: NativeView | null) {
  view = value;
  nativeSandbox().setSandboxViewToken(value?.session.viewToken ?? null);
}
export function trustedOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use the PC’s LAN HTTP or HTTPS origin");
  return url.origin;
}
/** Native SDK traffic gets only the active view capability; ordinary API traffic keeps its own bearer. */
export const nativeT3Fetch: typeof fetch = (input, init) => {
  const current = view;
  if (!current) return Promise.reject(new Error("Conversation view is not active"));
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
  if (url.origin !== current.origin)
    return Promise.reject(new Error("Native conversation origin changed"));
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.delete("authorization");
  headers.set("x-sandbox-view-token", current.session.viewToken);
  return fetch(input, { ...init, headers, redirect: "error" });
};
export function nativeT3Socket(url: string | URL): WebSocket {
  const current = view;
  if (!current) throw new Error("Conversation view is not active");
  const target = new URL(String(url));
  const origin = target.origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  if (!["ws:", "wss:"].includes(target.protocol) || origin !== current.origin)
    throw new Error("Native conversation origin changed");
  const Constructor = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new Constructor(target.toString(), [], {
    headers: { "x-sandbox-view-token": current.session.viewToken },
  });
}
