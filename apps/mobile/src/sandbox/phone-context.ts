import { createContext, useContext } from "react";
import type { SandboxApiClient } from "sandbox/client";
import type { PhoneState, PhoneTask } from "./model";
import type { PhoneHost } from "./view-controller";
export type PhoneContext = {
  host: PhoneHost | null;
  hosts: PhoneHost[];
  client: SandboxApiClient | null;
  connected: boolean;
  state: PhoneState;
  error: string | null;
  addHost: (name: string, origin: string, token: string) => Promise<void>;
  selectHost: (serverId: string) => void;
  removeHost: () => Promise<void>;
  open: (
    task: PhoneTask,
    conversationId: string | null,
    intent?: "open" | "new-conversation" | "settings",
  ) => Promise<void>;
  invoke: (task: PhoneTask, actionId: string, input: Record<string, unknown>) => Promise<void>;
  page: (cursor: string | null) => void;
  refresh: () => void;
  notificationSetup: () => Promise<void>;
  permission: string;
  notificationStatus: Awaited<ReturnType<SandboxApiClient["notificationStatus"]>> | null;
  muted: boolean;
  setMuted: (value: boolean) => Promise<void>;
};
export const PhoneContext = createContext<PhoneContext | null>(null);
export function usePhone() {
  const value = useContext(PhoneContext);
  if (!value) throw new Error("Sandbox host context unavailable");
  return value;
}
