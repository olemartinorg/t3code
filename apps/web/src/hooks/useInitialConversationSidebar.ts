import { hostIntegration } from "../hostIntegration";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function useInitialConversationSidebar({
  shellReady,
  environmentId,
  shells,
}: {
  pathname: string;
  shellReady: boolean;
  environmentId: EnvironmentId | null;
  shells: readonly EnvironmentThreadShell[];
  hasDraft?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(() => {
    return null;
  });
  const count = shells.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled",
  ).length;
  const open =
    manual ??
    hostIntegration()?.sidebar?.initial({ ready: shellReady, environmentId, openCount: count });
  const onOpenChange = (value: boolean) => {
    setManual(value);
    hostIntegration()?.sidebar?.changed(value);
  };
  return { open, onOpenChange };
}
