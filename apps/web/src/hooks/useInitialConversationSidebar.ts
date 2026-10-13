import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { soleOpenConversation, shouldCloseInitialSidebar } from "../sandboxConversationLaunch";

export function useInitialConversationSidebar({ pathname, shellReady, environmentId, shells, hasDraft }: {
  pathname: string;
  shellReady: boolean;
  environmentId: EnvironmentId | null;
  shells: readonly EnvironmentThreadShell[];
  hasDraft: boolean;
}) {
  const initialPathname = useRef(pathname);
  const resolved = useRef(false);
  const manuallyChanged = useRef(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!shellReady || environmentId === null || resolved.current) return;
    resolved.current = true;
    const sole = soleOpenConversation(shells, environmentId);
    if (!manuallyChanged.current && shouldCloseInitialSidebar(initialPathname.current, sole, hasDraft) &&
      shouldCloseInitialSidebar(pathname, sole, hasDraft)) setOpen(false);
  }, [shellReady, environmentId, shells, hasDraft, pathname]);
  const onOpenChange = (value: boolean) => {
    manuallyChanged.current = true;
    setOpen(value);
  };
  return { open, onOpenChange };
}
