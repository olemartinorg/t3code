import type { ComposerDraftPresenceEntry } from "@t3tools/contracts";

/** One serial writer per admitted desktop source and connection. */
export function startComposerDraftPresencePublisher(options: {
  readonly open: () => Promise<number>;
  readonly entries: () => readonly ComposerDraftPresenceEntry[];
  readonly replace: (
    writerEpoch: number,
    revision: number,
    entries: readonly ComposerDraftPresenceEntry[],
  ) => Promise<void>;
}) {
  let stopped = false;
  let busy = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let epoch: number | null = null;
  let revision = 0;
  let accepted: string | null = null;
  const schedule = (delay = 250) => {
    pending = true;
    if (stopped || busy || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void publish();
    }, delay);
  };
  const publish = async () => {
    if (stopped || busy) return;
    busy = true;
    pending = false;
    let retryDelay = 250;
    try {
      if (epoch === null) {
        epoch = await options.open();
        revision = 0;
      }
      if (stopped) return;
      const entries = options.entries();
      const signature = JSON.stringify(entries);
      if (signature === accepted) return;
      await options.replace(epoch, ++revision, entries);
      accepted = signature;
    } catch {
      epoch = null;
      accepted = null;
      retryDelay = 2_000;
      pending = true;
    } finally {
      busy = false;
      if (pending && !stopped) schedule(retryDelay);
    }
  };
  schedule(0);
  return {
    changed: () => schedule(),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
