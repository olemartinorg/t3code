import type { StateStorage } from "./lib/storage";

const KEY = "t3code:composer-drafts:v1";
const SAVED = "sandbox:t3-composer-saved:v1";
const CONFLICT = "sandbox:t3-composer-conflict:v1";
let dirty = false;
let editRevision = 0;
let pending = 0;
let generation = 0;
let reloadSaved = false;
let baseline: unknown = null;
let queue: Promise<void> = Promise.resolve();
let rehydrate = () => {};
const bridge = () => typeof window !== "undefined" && window.sandboxT3?.getComposer ? window.sandboxT3 : undefined;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const contentFields = ["attachments", "files", "terminalContexts", "previewAnnotations", "reviewComments", "threadContexts"] as const;
// Native hydration may rewrite empty metadata and model defaults. Only unsent
// composer content constitutes a competing user edit.
function draftContent(value: unknown) {
  const drafts = (value as { state?: { draftsByThreadKey?: Record<string, unknown> } } | null)?.state?.draftsByThreadKey ?? {};
  return Object.keys(drafts).sort().flatMap(key => {
    const value = drafts[key];
    if (!value || typeof value !== "object") return [];
    const draft = value as Record<string, unknown>;
    const prompt = typeof draft.prompt === "string" ? draft.prompt : "";
    const context = Object.fromEntries(contentFields.map(field => [field, Array.isArray(draft[field]) ? draft[field] : []]));
    return prompt.trim() || Object.values(context).some(items => items.length > 0) ? [{ key, prompt, ...context }] : [];
  });
}
const content = (raw: string | null) => {
  if (!raw) return false;
  try { return draftContent(JSON.parse(raw)).length > 0; } catch { return true; }
};
function chooseLocal(local: unknown): boolean {
  localStorage.setItem(CONFLICT, JSON.stringify(local));
  return window.confirm("Another Workbench changed this task's drafts. OK replaces the saved drafts with this device's copy. Cancel loads the saved drafts. Choose which draft to keep before continuing.");
}
const report = () => { void import("./components/ui/toast").then(({ toastManager }) => toastManager.add({ type: "error", title: "Draft could not be saved to Sandbox", description: "Your unsent draft remains on this device. Reopen the task after reconnecting." })); };
function save(value: unknown) {
  pending++;
  dirty = true;
  const ownGeneration = generation;
  const ownRevision = editRevision;
  let completed = false;
  const operation = queue.then(async () => {
    if (ownGeneration !== generation) { completed = true; return; }
    const host = bridge();
    if (!host?.saveComposer) throw new Error("Sandbox composer persistence unavailable");
    let result = await host.saveComposer(baseline, value);
    if (result.conflict) {
      const localContent = content(JSON.stringify(value));
      const remoteContent = content(JSON.stringify(result.current));
      const localChanged = !equal(draftContent(value), draftContent(baseline));
      if (!localChanged || !localContent || remoteContent && !chooseLocal(value)) {
        if (localChanged && localContent) generation++;
        reloadSaved = true;
        baseline = result.current;
        const raw = baseline === null ? null : JSON.stringify(baseline);
        if (raw === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, raw);
        localStorage.setItem(SAVED, JSON.stringify(baseline));
        completed = true;
        return;
      }
      baseline = result.current;
      result = await host.saveComposer(baseline, value);
    }
    if (!result.saved) throw new Error("Sandbox composer changed again during resolution");
    baseline = value;
    localStorage.setItem(SAVED, JSON.stringify(value));
    reloadSaved = false;
    completed = true;
  });
  queue = operation.catch(report).finally(() => {
    pending--;
    // A newer edit may still be waiting in T3's deferred storage, outside this queue.
    if (pending === 0 && completed && ownRevision === editRevision) {
      dirty = false;
      if (reloadSaved || !equal(bridge()?.getComposer?.(), baseline)) {
        reloadSaved = false;
        rehydrate();
      }
    }
  });
}
export function composerPersistenceDirty() {
  if (bridge()) { dirty = true; editRevision++; }
}
export function composerPersistenceChanged(callback: () => void) {
  rehydrate = callback;
  bridge()?.onState?.(() => {
    // Own save acknowledgements and unrelated layout/settings changes need no hydration.
    if (!dirty && !equal(bridge()?.getComposer?.(), baseline)) callback();
  });
}
export function sandboxComposerStorage(): StateStorage | undefined {
  const host = bridge();
  if (!host) return undefined;
  return {
    getItem: name => {
      if (name !== KEY) throw new Error("Unsupported composer persistence key");
      const current = host.getComposer!();
      const local = localStorage.getItem(KEY);
      const saved = localStorage.getItem(SAVED);
      baseline = current;
      const remote = current === null ? null : JSON.stringify(current);
      if (content(local) && !equal(draftContent(JSON.parse(local!)), draftContent(saved ? JSON.parse(saved) : null)) && local !== remote && chooseLocal(JSON.parse(local!))) {
        save(JSON.parse(local!));
        return local;
      }
      if (remote === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, remote);
      localStorage.setItem(SAVED, JSON.stringify(current));
      return remote;
    },
    setItem: (name, value) => {
      if (name !== KEY) throw new Error("Unsupported composer persistence key");
      localStorage.setItem(KEY, value);
      save(JSON.parse(value));
    },
    removeItem: name => {
      if (name !== KEY) throw new Error("Unsupported composer persistence key");
      localStorage.removeItem(KEY);
      save(null);
    },
  };
}
