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
function Layout(props: Parameters<typeof useInitialConversationSidebar>[0]) { sidebar = useInitialConversationSidebar(props); return <div data-open={sidebar.open} />; }
async function render(props = ready) { await act(async () => { if (renderer) renderer.update(<Layout {...props} />); else renderer = create(<Layout {...props} />); }); }
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => renderer?.unmount());renderer=null;vi.unstubAllGlobals(); });
test("waits for both native shell and environment identity before closing once", async () => {
  await render({ ...ready, shellReady: false, environmentId: null } as never);expect(sidebar.open).toBe(true);
  await render({ ...ready, environmentId: null } as never);expect(sidebar.open).toBe(true);
  await render();expect(sidebar.open).toBe(false);
  await act(async () => sidebar.onOpenChange(true));
  await render({ ...ready, shells: [{ ...thread, updatedAt: "later" } as never] });expect(sidebar.open).toBe(true);
});
test("a manual toggle during loading owns the sidebar thereafter", async () => {
  await render({ ...ready, shellReady: false });
  await act(async () => { sidebar.onOpenChange(false);sidebar.onOpenChange(true); });
  await render();expect(sidebar.open).toBe(true);
});
test("a changed explicit route during loading is not overridden by the sole launch", async () => {
  await render({ ...ready, shellReady: false });
  await render({ ...ready, pathname: `/${environmentId}/other` });expect(sidebar.open).toBe(true);
});
test.each(["/draft/new", "/settings", `/${environmentId}/other`])("preserves explicit %s launch", async pathname => { await render({ ...ready, pathname });expect(sidebar.open).toBe(true); });
test("retains content-bearing drafts and zero/multiple-conversation launches", async () => {
  await render({ ...ready, hasDraft: true });expect(sidebar.open).toBe(true);
  await render();expect(sidebar.open).toBe(true);
});
