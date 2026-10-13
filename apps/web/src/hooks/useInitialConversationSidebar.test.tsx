// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import { useInitialConversationSidebar } from "./useInitialConversationSidebar";
const environmentId = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
const thread = { id: "one", environmentId, archivedAt: null, settledOverride: null } as unknown as EnvironmentThreadShell;
const ready = { pathname: "/", shellReady: true, environmentId, shells: [thread], hasDraft: false };
let renderer: ReactTestRenderer | null = null;
let sidebar: ReturnType<typeof useInitialConversationSidebar>;
function Layout(props: Parameters<typeof useInitialConversationSidebar>[0]) { sidebar = useInitialConversationSidebar(props); return null; }
async function render(props = ready) { await act(async () => { if (renderer) renderer.update(<Layout {...props} />); else renderer = create(<Layout {...props} />); }); }
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = null; vi.unstubAllGlobals(); });
test("begins closed while native identity and count load", async () => {
  await render({ ...ready, shellReady: false, environmentId: null } as never); expect(sidebar.open).toBe(false);
  await render(); expect(sidebar.open).toBe(false);
});
test.each(["/", "/draft/new", "/settings", `/${environmentId}/one`])("zero/one conversation stays closed on %s including retained drafts", async pathname => {
  await render({ ...ready, pathname, hasDraft: true, shells: [] }); expect(sidebar.open).toBe(false);
  await render({ ...ready, pathname, hasDraft: true }); expect(sidebar.open).toBe(false);
});
test("count defaults update without persisting automatic choices", async () => {
  await render({ ...ready, shells: [thread, { ...thread, id: "two" } as never] }); expect(sidebar.open).toBe(true);
  expect(window.localStorage.getItem("sandbox:t3-sidebar-manual:v1")).toBeNull();
  await render({ ...ready, shells: [thread, { ...thread, id: "two", settledOverride: "settled" } as never] }); expect(sidebar.open).toBe(false);
  await render({ ...ready, shells: [thread, { ...thread, id: "two", archivedAt: "now" } as never] }); expect(sidebar.open).toBe(false);
});
test.each([false, true])("manual %s survives count/route changes and reopen", async open => {
  await render({ ...ready, shellReady: false });
  await act(async () => sidebar.onOpenChange(open));
  await render({ ...ready, pathname: "/draft/new", shells: [thread, { ...thread, id: "two" } as never] }); expect(sidebar.open).toBe(open);
  await act(async () => renderer?.unmount()); renderer = null;
  await render(); expect(sidebar.open).toBe(open);
});
