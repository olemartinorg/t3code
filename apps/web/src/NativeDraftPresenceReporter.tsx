import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ComposerDraftPresenceSource,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectionAtomRuntime } from "./connection/runtime";
import { composerDraftPresenceEntries } from "./composerDraftPresence";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  flushComposerDrafts,
  readSavedComposerDraftPresenceState,
  useComposerDraftStore,
} from "./composerDraftStore";
import { isElectron } from "./env";
import { hostIntegration } from "./hostIntegration";
import { useServerConfigs } from "./state/entities";
import { useEnvironmentScope } from "./state/session";
import { environmentShell } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { randomUUID } from "./lib/utils";
import { startComposerDraftPresencePublisher } from "./composerDraftPresencePublisher";

const subscribeHydration = (listener: () => void) =>
  useComposerDraftStore.persist.onFinishHydration(listener);
const sourceStorageKey = "t3code:desktop-draft-presence-source:v1";
const decodeSource = Schema.decodeUnknownSync(ComposerDraftPresenceSource);
const scheduler = createAtomCommandScheduler();
const concurrency = {
  mode: "serial" as const,
  key: ({ environmentId }: { environmentId: string }) => environmentId,
};
const openSource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "composer-presence:open",
  tag: ORCHESTRATION_V2_WS_METHODS.openDraftPresenceSource,
  scheduler,
  concurrency,
});
const replacePresence = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "composer-presence:replace",
  tag: ORCHESTRATION_V2_WS_METHODS.replaceDraftPresence,
  scheduler,
  concurrency,
});

/** Mounted only by the standalone desktop, never by mobile or host-owned composers. */
export function NativeDraftPresenceReporter() {
  const configs = useServerConfigs();
  const [source, setSource] = useState<typeof ComposerDraftPresenceSource.Type | null>(null);
  useEffect(() => {
    if (
      !isElectron ||
      (hostIntegration()?.composer && !hostIntegration()?.composer?.nativePresence) ||
      !navigator.locks
    )
      return;
    const controller = new AbortController();
    void navigator.locks
      .request("t3code:desktop-draft-presence", { signal: controller.signal }, async () => {
        try {
          const saved = localStorage.getItem(sourceStorageKey);
          const identity =
            saved === null
              ? { sourceId: randomUUID(), sourceToken: randomUUID() }
              : decodeSource(JSON.parse(saved));
          if (saved === null) localStorage.setItem(sourceStorageKey, JSON.stringify(identity));
          if (!controller.signal.aborted) setSource(identity);
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        } catch {
          /* Local editing continues when profile storage is unavailable. */
        }
      })
      .catch(() => {});
    return () => {
      controller.abort();
      setSource(null);
    };
  }, []);
  if (!source) return null;
  return [...configs]
    .filter(([, config]) => config.environment.capabilities.composerDraftPresence === 1)
    .map(([environmentId]) => (
      <EnvironmentDraftPresenceReporter
        key={environmentId}
        environmentId={environmentId}
        source={source}
      />
    ));
}

function EnvironmentDraftPresenceReporter({
  environmentId,
  source,
}: {
  readonly environmentId: EnvironmentId;
  readonly source: typeof ComposerDraftPresenceSource.Type;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const allowed = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    useComposerDraftStore.persist.hasHydrated,
  );
  const latest = useRef(shell);
  const wake = useRef<(() => void) | null>(null);
  const dirty = useRef(false);
  const localDocument = useRef(false);
  const open = useAtomCommand(openSource, { reportFailure: false, reportDefect: false });
  const replace = useAtomCommand(replacePresence, { reportFailure: false, reportDefect: false });
  const ready = shell.status === "live" && Option.isSome(shell.snapshot);

  useEffect(
    () =>
      useComposerDraftStore.subscribe(() => {
        dirty.current = true;
        localDocument.current = true;
        wake.current?.();
      }),
    [],
  );
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === COMPOSER_DRAFT_STORAGE_KEY) {
        if (!dirty.current) localDocument.current = false;
        wake.current?.();
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(
    () => hostIntegration()?.composer?.nativePresence?.subscribe(() => wake.current?.()),
    [],
  );
  useEffect(() => {
    latest.current = shell;
    wake.current?.();
  }, [shell]);
  useEffect(() => {
    if (!ready || !allowed || !hydrated) return;
    const publisher = startComposerDraftPresencePublisher({
      open: async () => {
        const result = await open({ environmentId, input: source });
        if (!AsyncResult.isSuccess(result)) throw new Error("presence source unavailable");
        return result.value.writerEpoch;
      },
      entries: () => {
        if (latest.current.status !== "live" || Option.isNone(latest.current.snapshot))
          throw new Error("presence snapshot unavailable");
        // Publishing follows a successful local save; a failed save cannot clear retained metadata.
        if (dirty.current) {
          flushComposerDrafts();
          dirty.current = false;
        }
        const entries = composerDraftPresenceEntries(
          localDocument.current
            ? useComposerDraftStore.getState()
            : readSavedComposerDraftPresenceState(),
          environmentId,
          latest.current.snapshot.value,
        );
        return (
          hostIntegration()?.composer?.nativePresence?.filter(environmentId, entries) ?? entries
        );
      },
      replace: async (writerEpoch, revision, entries) => {
        const result = await replace({
          environmentId,
          input: { ...source, writerEpoch, revision, entries },
        });
        if (!AsyncResult.isSuccess(result)) throw new Error("presence report unavailable");
      },
    });
    wake.current = publisher.changed;
    return () => {
      wake.current = null;
      publisher.stop();
    };
  }, [allowed, environmentId, hydrated, open, ready, replace, source]);
  return null;
}
