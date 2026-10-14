// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useInitialConversationSidebar } from "./useInitialConversationSidebar";
import { SidebarProvider, useSidebar } from "../components/ui/sidebar";

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => viewport.mobile }));
let renderer: ReactTestRenderer;
let sidebar: ReturnType<typeof useSidebar>;
function Probe() {
  sidebar = useSidebar();
  return null;
}
function Layout({ mobile }: { mobile: boolean }) {
  const control = useInitialConversationSidebar({
    pathname: "/thread",
    shellReady: true,
    environmentId: null,
    shells: [],
  });
  return (
    <SidebarProvider {...control} data-mobile={mobile}>
      <Probe />
    </SidebarProvider>
  );
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  delete window.t3Host;
  vi.unstubAllGlobals();
});
it("keeps the standalone desktop sidebar open after selecting a conversation in the mobile drawer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport.mobile = true;
  await act(async () => {
    renderer = create(<Layout mobile={true} />);
  });
  await act(async () => {
    sidebar.setOpenMobile(true);
  });
  expect(sidebar.openMobile).toBe(true);
  await act(async () => {
    sidebar.setOpenMobile(false);
  });
  viewport.mobile = false;
  await act(async () => {
    renderer.update(<Layout mobile={false} />);
  });
  expect(sidebar.isMobile).toBe(false);
  expect(sidebar.open).toBe(true);
  expect(sidebar.openMobile).toBe(false);
});
