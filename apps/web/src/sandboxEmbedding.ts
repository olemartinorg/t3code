import { useSyncExternalStore } from "react";

export interface SandboxEmbedding {
  readonly version: 1;
  readonly getVisible: () => boolean;
  readonly onVisibility: (listener: () => void) => () => void;
}

function embedding(): SandboxEmbedding | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.sandboxT3;
  return bridge?.version === 1 ? bridge : undefined;
}

export function isSandboxEmbedded(): boolean {
  return embedding() !== undefined;
}

const subscribe = (listener: () => void) => embedding()?.onVisibility(listener) ?? (() => {});
const visible = () => embedding()?.getVisible() ?? true;

// Only the authenticated native pane owner supplies this signal. A browser's
// visibility, route, local storage or debugging state cannot mark a pane read.
export function useSandboxPaneVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, () => false);
}
