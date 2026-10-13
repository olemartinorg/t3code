// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  newThread: vi.fn(),
  projects: [] as unknown[],
  threads: [] as unknown[],
  groups: [] as unknown[],
  drafts: { draftsByThreadKey: {}, draftThreadsByThreadKey: {} } as unknown,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "authenticated" } }),
  }),
  useNavigate: () => state.navigate,
  Link: () => null,
}));
vi.mock("../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShells: () => state.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "chosen-env",
  useEnvironments: () => ({ environments: [], isReady: true }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
vi.mock("../components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => state.groups,
}));
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (id: string) => id },
  composerDraftHasUserContent: (draft: { prompt?: string } | undefined) => Boolean(draft?.prompt),
  useComposerDraftStore: (selector: (value: unknown) => unknown) => selector(state.drafts),
}));
vi.mock("../components/NoProjectsHero", () => ({ NoProjectsHero: () => null }));
vi.mock("../components/Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown[]) => projects,
}));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/ui/empty", () => ({
  Empty: ({ children }: { children: unknown }) => children,
  EmptyHeader: ({ children }: { children: unknown }) => children,
  EmptyTitle: ({ children }: { children: unknown }) => children,
  EmptyDescription: ({ children }: { children: unknown }) => children,
}));

import { Route } from "./_chat.index";
let renderer: ReactTestRenderer | undefined;
const project = { id: "chosen-project", environmentId: "chosen-env" };
const thread = {
  id: "chosen-thread",
  environmentId: "chosen-env",
  projectId: "chosen-project",
  archivedAt: null,
  settledOverride: null,
};

beforeEach(() => {
  state.navigate.mockReset();
  state.newThread.mockReset().mockResolvedValue(null);
  state.projects = [{ id: "other-project", environmentId: "chosen-env" }, project];
  state.threads = [thread];
  state.groups = [];
  state.drafts = { draftsByThreadKey: {}, draftThreadsByThreadKey: {} };
  window.sandboxT3 = {
    version: 1,
    getTargetKind: () => "external-t3",
    getProjectId: () => "chosen-project",
    getVisible: () => true,
    onVisibility: () => () => {},
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  delete window.sandboxT3;
});
async function open() {
  const Component = Route.options.component!;
  await act(async () => {
    renderer = create(<Component />);
  });
}

test("explicit New bypasses existing conversation and unsent work, using the native draft handler", async () => {
  window.sandboxT3 = { ...window.sandboxT3!, getOpenIntent: () => "new-conversation" };
  state.drafts = {
    draftsByThreadKey: { old: { prompt: "Existing unsent work" } },
    draftThreadsByThreadKey: {
      old: {
        environmentId: "chosen-env",
        projectId: "chosen-project",
        promotedTo: null,
        createdAt: "2026-10-13",
      },
    },
  };
  await open();
  expect(state.newThread).toHaveBeenCalledExactlyOnceWith(
    { environmentId: "chosen-env", projectId: "chosen-project" },
    { replace: true },
  );
  expect(state.navigate).not.toHaveBeenCalled();
});
test("ordinary Open selects the sole conversation only in the selected project", async () => {
  state.threads = [{ ...thread, id: "other-thread", projectId: "other-project" }, thread];
  await open();
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "chosen-env", threadId: "chosen-thread" },
    replace: true,
  });
  expect(state.newThread).not.toHaveBeenCalled();
});
test("Settings resolves the exact native member despite logical project grouping", async () => {
  window.sandboxT3 = { ...window.sandboxT3!, getOpenIntent: () => "settings" };
  state.groups = [
    {
      projectKey: "logical-group",
      memberProjects: [{ ...project, physicalProjectKey: "chosen-env:/repo" }],
    },
  ];
  await open();
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/settings/projects",
    search: { project: "logical-group", machine: "chosen-env", checkout: "chosen-env:/repo" },
    replace: true,
  });
  expect(state.newThread).not.toHaveBeenCalled();
});
test("No project cannot create a fake native project or select unrelated work", async () => {
  window.sandboxT3 = { ...window.sandboxT3!, getProjectId: () => null };
  window.sandboxT3 = { ...window.sandboxT3!, getOpenIntent: () => "new-conversation" };
  await open();
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

test("No project Open retains access to the sole unassigned native conversation", async () => {
  window.sandboxT3 = { ...window.sandboxT3!, getProjectId: () => null };
  state.threads = [thread, { ...thread, id: "unassigned", projectId: null }];
  await open();
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "chosen-env", threadId: "unassigned" },
    replace: true,
  });
  expect(state.newThread).not.toHaveBeenCalled();
});

test("managed task root launch retains its native environment-wide selection", async () => {
  window.sandboxT3 = { ...window.sandboxT3!, getTargetKind: () => "managed-task" };
  state.threads = [{ ...thread, id: "another-project", projectId: "other-project" }];
  await open();
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "chosen-env", threadId: "another-project" },
    replace: true,
  });
  expect(state.newThread).not.toHaveBeenCalled();
});

test("No project Settings opens the native environment scope", async () => {
  window.sandboxT3 = {
    ...window.sandboxT3!,
    getProjectId: () => null,
    getOpenIntent: () => "settings",
  };
  await open();
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/settings/general",
    search: { machine: "chosen-env" },
    replace: true,
  });
  expect(state.newThread).not.toHaveBeenCalled();
});
