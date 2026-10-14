import type { WebSocketConstructorOptions } from "effect/socket/Socket";
import type { File } from "expo-file-system";

/** Optional host integrations. The standalone T3 app keeps its normal defaults. */
export type MobileIntegration = {
  fetch?: typeof fetch;
  socket?: (url: string | URL) => WebSocket;
  reconnect?: () => Promise<void>;
  threadTools?: boolean;
  defaultThemeMode?: "light" | "dark" | "system";
  renderHtmlAttachments?: boolean;
  downloadAttachment?: (url: string, file: File, signal: AbortSignal) => Promise<void>;
  uploadAttachment?: (
    url: string,
    file: File,
    mime: string,
    signal: AbortSignal,
    progress?: (fraction: number) => void,
  ) => Promise<void>;
};
let integration: MobileIntegration = {};
/** Configure once from the embedding app entrypoint, before importing its screens. */
export function configureMobileIntegration(value: MobileIntegration): void {
  integration = value;
}
export function mobileIntegration(): MobileIntegration {
  return integration;
}
export const mobileFetch: typeof fetch = (input, init) =>
  (integration.fetch ?? globalThis.fetch)(input, init);
export function mobileWebSocket(url: string, options?: WebSocketConstructorOptions): WebSocket {
  if (integration.socket) return integration.socket(url);
  if (options !== undefined && typeof options !== "string" && !Array.isArray(options))
    throw new TypeError(
      "WebSocket client options are not supported by the global WebSocket constructor",
    );
  return new globalThis.WebSocket(url, options);
}
