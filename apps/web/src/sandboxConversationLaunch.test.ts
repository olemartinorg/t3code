import { expect, test } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import { composerDraftHasUserContent, useComposerDraftStore } from "./composerDraftStore";
import { hasNewThreadDraftContent, soleOpenConversation, shouldCloseInitialSidebar } from "./sandboxConversationLaunch";
const env = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
const thread = { id: "one", environmentId: env, archivedAt: null, settledOverride: null } as unknown as EnvironmentThreadShell;
test("only open conversations of the task environment select the sole launch", () => {
  expect(soleOpenConversation([thread], env)).toBe(thread);
  expect(soleOpenConversation([], env)).toBeNull();
  expect(soleOpenConversation([thread, { ...thread, id: "two" } as EnvironmentThreadShell], env)).toBeNull();
  expect(soleOpenConversation([thread, { ...thread, id: "archive", archivedAt: "2026-10-07" } as EnvironmentThreadShell, { ...thread, id: "settled", settledOverride: "settled" } as EnvironmentThreadShell], env)).toBe(thread);
  expect(soleOpenConversation([thread], null)).toBeNull();
});
test("index and explicit sole-thread launch close the sidebar, while other routes and drafts retain it", () => {
  expect(shouldCloseInitialSidebar("/", thread, false)).toBe(true);
  expect(shouldCloseInitialSidebar(`/${env}/one`, thread, false)).toBe(true);
  for (const path of [`/${env}/other`, "/draft/draft", "/settings"]) expect(shouldCloseInitialSidebar(path, thread, false)).toBe(false);
  expect(shouldCloseInitialSidebar("/", thread, true)).toBe(false);
});
test("every composer content field protects a new-thread draft, including metadata-only files", () => {
  const empty = { prompt: "", images: [], files: [], persistedAttachments: [], terminalContexts: [], previewAnnotations: [], reviewComments: [], threadContexts: [] };
  expect(composerDraftHasUserContent(empty as never)).toBe(false);
  for (const field of ["images", "files", "persistedAttachments", "terminalContexts", "previewAnnotations", "reviewComments", "threadContexts"]) {
    const draft = { ...empty, [field]: [{}] };
    expect(composerDraftHasUserContent(draft as never)).toBe(true);
    const state = { ...useComposerDraftStore.getState(), draftsByThreadKey: { draft: draft as never }, draftThreadsByThreadKey: { draft: { promotedTo: null } as never } };
    expect(hasNewThreadDraftContent(state)).toBe(true);
  }
  expect(composerDraftHasUserContent({ ...empty, prompt: "Unsent work" } as never)).toBe(true);
});
