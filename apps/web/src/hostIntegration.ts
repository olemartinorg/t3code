import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { StateStorage } from "./lib/storage";
import type {
  ClientSettings,
  ModelSelection,
  ServerSettings,
  ComposerDraftPresenceEntry,
} from "@t3tools/contracts";

/** Optional embedding services supplied before the native client is loaded. */
export interface HostIntegration {
  readonly hasUnseenCompletion?: (thread: {
    lastCompletionAt?: string | null | undefined;
    lastVisitedAt?: string | null | undefined;
  }) => boolean;
  readonly useThreadVisit?: (thread: EnvironmentThreadShell | null, routeKey: string) => void;
  readonly serverSettingsDefaults?: Partial<ServerSettings>;
  readonly externalNavigation?: boolean;
  readonly defaultThreadDetailsOpen?: boolean;
  readonly Landing?: ComponentType;
  readonly Connections?: ComponentType;
  readonly managesConnections?: boolean;
  readonly migratesVisitedState?: boolean;
  readonly updateNotice?: (environmentId: string) => ReactNode;
  readonly reportPanelPresence?: (present: boolean) => void;
  readonly visibility?: { get: () => boolean; subscribe: (listener: () => void) => () => void };
  readonly composer?: {
    storage: StateStorage;
    changed: (rehydrate: () => void) => void;
    dirty: (flush: () => void) => void;
    /** Remote prompt updates retain locally owned runtime composer content. */
    textOnlyHydration?: boolean;
    /** Standalone integrations may retain native presence for content they do not own. */
    nativePresence?: {
      filter: (
        environmentId: string,
        entries: ComposerDraftPresenceEntry[],
      ) => ComposerDraftPresenceEntry[];
      subscribe: (listener: () => void) => () => void;
    };
  };
  readonly settings?: {
    read: () => Record<string, unknown>;
    write: (settings: ClientSettings) => Promise<void>;
    subscribe: (listener: () => void) => () => void;
    modelSaved?: (input: {
      model: ModelSelection | null;
      writtenEnvironments: readonly string[];
      failedEnvironments: readonly string[];
    }) => Promise<void>;
  };
  readonly appearance?: {
    defaultMode?: "light" | "dark" | "system";
    read: () => unknown;
    write: (value: "light" | "dark" | "system") => void;
  };
  readonly useSidebar?: () => { open?: boolean; onOpenChange?: (open: boolean) => void };
}
declare global {
  interface Window {
    t3Host?: HostIntegration;
  }
}
export function hostIntegration(): HostIntegration | undefined {
  return typeof window === "undefined" ? undefined : window.t3Host;
}
const subscribe = (listener: () => void) =>
  hostIntegration()?.visibility?.subscribe(listener) ?? (() => {});
const visible = () => hostIntegration()?.visibility?.get() ?? true;
export function useHostPaneVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, () => false);
}
