import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

const manualChoiceKey = "sandbox:t3-sidebar-manual:v1";
export function useInitialConversationSidebar({ shellReady, environmentId, shells }: {
  pathname: string;
  shellReady: boolean;
  environmentId: EnvironmentId | null;
  shells: readonly EnvironmentThreadShell[];
  hasDraft: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(() => {
    const value = window.localStorage.getItem(manualChoiceKey);
    return value === "true" ? true : value === "false" ? false : null;
  });
  const count = shells.filter(thread => thread.environmentId === environmentId &&
    thread.archivedAt === null && thread.settledOverride !== "settled").length;
  const open = manual ?? (shellReady && environmentId !== null && count > 1);
  const onOpenChange = (value: boolean) => {
    setManual(value);
    window.localStorage.setItem(manualChoiceKey, String(value));
  };
  return { open, onOpenChange };
}
