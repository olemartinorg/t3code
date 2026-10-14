// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ScopedThreadRef } from "@t3tools/contracts";
const calls = vi.hoisted(() => ({ panel: vi.fn(), link: vi.fn(), external: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => calls.link }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => calls.panel }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: calls.external } }),
}));
vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: {} }),
}));
import { HtmlRenderDocument } from "./BrowserDocumentFrame";
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  delete window.t3Host;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([
  { external: false, panel: true, modifier: false, expected: "panel" },
  { external: false, panel: false, modifier: false, expected: "link" },
  { external: false, panel: true, modifier: true, expected: "external" },
  { external: true, panel: true, modifier: false, expected: "external" },
])(
  "routes HTML clicks through $expected (external=$external, modifier=$modifier)",
  async ({ external, panel, modifier, expected }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (external) window.t3Host = { externalNavigation: true };
    calls.panel.mockReturnValue(panel);
    calls.link.mockResolvedValue(undefined);
    calls.external.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <HtmlRenderDocument
          src="https://example.test/render"
          title="HTML"
          threadRef={{ environmentId: "environment", threadId: "thread" } as ScopedThreadRef}
        />,
      );
    });
    const frame = container.querySelector("iframe")!;
    frame.focus();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow!,
        data: {
          jsonrpc: "2.0",
          id: "click",
          method: "ui/open-link",
          params: { url: "https://example.test/pull/1", metaKey: modifier, ctrlKey: false },
        },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls[expected as keyof typeof calls]).toHaveBeenCalledTimes(1);
    if (expected === "external") {
      expect(calls.panel).not.toHaveBeenCalled();
      expect(calls.link).not.toHaveBeenCalled();
    }
    if (expected === "panel") {
      expect(calls.link).not.toHaveBeenCalled();
      expect(calls.external).not.toHaveBeenCalled();
    }
  },
);
