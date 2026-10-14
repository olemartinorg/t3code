import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { PhoneContext as PhoneContextValue } from "./phone-context";
import type { PhoneTask } from "./model";

// Real Phone hooks/handlers with a DOM host and native transport/screen leaves replaced.
// Uses existing workspace tools; these checks do not substitute for phone acceptance.
const web = createRequire(new URL("../../../web/package.json", import.meta.url));
const sandbox = createRequire(new URL("../../../../../../package.json", import.meta.url));
const React = web("react") as typeof import("react");
const { createRoot } = web("react-dom/client") as {
  createRoot: (container: Element) => { render: (node: unknown) => void; unmount: () => void };
};
const { JSDOM } = sandbox("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis };
};
vi.doMock("react", () => React);
const context = React.createContext<PhoneContextValue | null>(null);
let phone!: PhoneContextValue;
let onStateChange!: (state: { index: number; routes: unknown[] }) => void;
let notice!: (event: { url: string }) => void;
let events!: (frame: unknown) => void;
let currentView: any = null;
let root: ReturnType<typeof createRoot>;
let windows: InstanceType<typeof JSDOM>;
const host = {
  serverId: "11111111-1111-4111-8111-111111111111",
  name: "PC",
  origin: "http://pc.local:19480",
  token: "fixture-only",
  notifications: true,
};
const stacks: any[] = [];
const navigate = vi.fn();
const openView = vi.fn(async (_host: unknown, target: any) => {
  currentView = {
    session: {
      environmentId: target.environmentId ?? target.taskId,
      conversationId: target.conversationId,
    },
  };
  return currentView;
});
let tasks: PhoneTask[];
let invoke = vi.fn<(...args: unknown[]) => Promise<any>>();
const wrapper = ({ children }: { children?: unknown } = {}) => children;
vi.doMock("./phone-context", () => ({ PhoneContext: context }));
vi.doMock("@effect/atom-react", () => ({ RegistryContext: React.createContext(null) }));
vi.doMock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ({ navigate, isReady: () => true }),
  createStaticNavigation: () => (props: any) => {
    phone = React.useContext(context)!;
    onStateChange = props.onStateChange;
    return null;
  },
}));
vi.doMock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: (config: unknown) => {
    stacks.push(config);
    return config;
  },
  createNativeStackScreen: (screen: unknown) => screen,
}));
vi.doMock("react-native", () => ({
  View: wrapper,
  StatusBar: () => null,
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Linking: {
    addEventListener: (_event: string, callback: typeof notice) => {
      notice = callback;
      return { remove() {} };
    },
    getInitialURL: async () => null,
  },
}));
vi.doMock("react-native-gesture-handler", () => ({ GestureHandlerRootView: wrapper }));
vi.doMock("react-native-keyboard-controller", () => ({ KeyboardProvider: wrapper }));
vi.doMock("react-native-safe-area-context", () => ({ SafeAreaProvider: wrapper }));
vi.doMock("expo-splash-screen", () => ({ hideAsync: async () => {} }));
vi.doMock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: false, status: "denied" }),
  addPushTokenListener: () => ({ remove() {} }),
  getDevicePushTokenAsync: async () => ({ data: "fixture-token" }),
}));
vi.doMock("expo-constants", () => ({
  default: { expoConfig: { extra: { androidPushConfigured: false } } },
}));
vi.doMock("expo-crypto", () => ({ randomUUID: () => "fixture-idempotency-key" }));
vi.doMock("sandbox/client", () => ({
  EventCursor: class {},
  SandboxApiClient: class {
    identity = async () => ({ serverId: host.serverId });
    tasks = async () => ({ tasks });
    notificationStatus = async () => null;
    registerPhone = async () => {};
    invokeTask = (...args: unknown[]) => invoke(...args);
    connectEvents = async (options: any) => {
      events = options.onEvent;
      return { close() {} };
    };
  },
}));
vi.doMock("sandbox/contracts", () => ({
  notificationPayloadSchema: { parse: (payload: unknown) => payload },
}));
vi.doMock("./profiles", () => ({
  readPhoneHosts: async () => [host],
  savePhoneHosts: async () => {},
  installationId: async () => "22222222-2222-4222-8222-222222222222",
}));
vi.doMock("./transport", () => ({
  nativeSandbox: () => ({
    configureSandboxNotifications() {},
    selectSandboxHost() {},
    setSandboxThreadOnScreen() {},
  }),
  trustedOrigin: (origin: string) => origin,
  currentNativeView: () => currentView,
}));
vi.doMock("./view-controller", () => ({
  openPhoneView: openView,
  closePhoneView: async () => {
    currentView = null;
  },
}));
vi.doMock("./reconnect", () => ({ setPhoneReconnect() {} }));
for (const [path, names] of [
  ["../state/atom-registry", ["appAtomRegistry"]],
  ["../state/use-thread-outbox-drain", ["useThreadOutboxDrain"]],
  ["../state/composer-attachment-uploads", ["useComposerAttachmentUploadWorker"]],
  ["../lib/useMobileNavigationTheme", ["useMobileNavigationTheme"]],
  [
    "../features/settings/appearance/AppearancePreferencesProvider",
    ["AppearancePreferencesProvider"],
  ],
  ["../features/voice-input/VoiceInputProvider", ["VoiceInputProvider"]],
  ["../features/voice-input/GlobalVoiceInputControl", ["GlobalVoiceInputControl"]],
  ["../features/sharing/IncomingShareProvider", ["IncomingShareProvider"]],
  ["../components/ConfirmDialogHost", ["ConfirmDialogHost"]],
  ["../components/OverlayPortal", ["OverlayPortalHost"]],
  ["../features/threads/ThreadArrangementSheet", ["ThreadArrangementHost"]],
  ["../features/keyboard/HardwareKeyboardCommandProvider", ["HardwareKeyboardCommandProvider"]],
  [
    "../features/threads/ThreadSettingsSheet",
    [
      "ExistingThreadSettingsRouteProvider",
      "ExistingThreadSettingsRouteScreen",
      "NewTaskThreadSettingsRouteScreen",
    ],
  ],
  ["../features/threads/ThreadRouteScreen", ["ThreadRouteScreen"]],
  ["../features/threads/ThreadAgentsSheet", ["ThreadAgentsSheet"]],
  ["../features/threads/ThreadQueueControl", ["ThreadQueueSheet"]],
  ["../features/threads/NewTaskDraftRouteScreen", ["NewTaskDraftRouteScreen"]],
  ["../features/threads/new-task-flow-provider", ["NewTaskFlowProvider"]],
  ["../features/files/AttachmentFileScreen", ["AttachmentFileScreen"]],
  ["../features/files/ThreadFilesRouteScreen", ["ThreadFileScreen"]],
  [
    "../features/settings/SettingsOpenSourceLicensesRouteScreen",
    ["SettingsOpenSourceLicenseRouteScreen", "SettingsOpenSourceLicensesRouteScreen"],
  ],
  ["../features/settings/SettingsLegalRouteScreen", ["SettingsLegalRouteScreen"]],
  [
    "../features/threads/NewTaskContextPickerScreens",
    ["NewTaskBranchPickerRouteScreen", "NewTaskEnvironmentPickerRouteScreen"],
  ],
  ["../features/settings/settings-environment-filter", ["SettingsEnvironmentFilterProvider"]],
  ["./SettingsScope", ["SettingsScope"]],
  ["./Home", ["Home"]],
  ["./Notices", ["Notices"]],
] as const)
  vi.doMock(path, () => Object.fromEntries(names.map((name) => [name, wrapper])));
const { default: App } = await import("./CompanionApp");

function task(id: string, kind = "sandbox"): PhoneTask {
  return {
    id,
    kind,
    name: id,
    stableId: id,
    environmentId: id,
    projectId: "project",
    connection: "connected",
    conversations: [{ id: "one" }, { id: "two" }],
    presentation: { running: false, actions: [{ kind: "action", id: "open", enabled: true }] },
  } as unknown as PhoneTask;
}
async function flush(work: () => void | Promise<unknown> = () => {}) {
  await React.act(async () => {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function complete() {
  tasks = tasks.map((task) =>
    task.id === "A" ? { ...task, presentation: { ...task.presentation, running: true } } : task,
  );
  events({
    type: "state",
    serverId: host.serverId,
    subscriptions: [
      { topic: "tasks", scope: "active", data: { tasks } },
      { topic: "operations", data: [{ id: "start-operation", state: "succeeded" }] },
    ],
  });
}
beforeEach(async () => {
  windows = new JSDOM("<div id='root'></div>");
  vi.stubGlobal("window", windows.window);
  vi.stubGlobal("document", windows.window.document);
  vi.stubGlobal("navigator", windows.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tasks = [task("A"), task("B")];
  currentView = null;
  navigate.mockClear();
  openView.mockClear();
  invoke = vi.fn(async () => ({
    launch: { conversationId: "one" },
    operation: { id: "start-operation" },
  }));
  root = createRoot(document.querySelector("#root")!);
  await flush(() => root.render(React.createElement(App)));
  await flush();
});
afterEach(async () => {
  await flush(() => root.unmount());
  windows.window.close();
  vi.unstubAllGlobals();
});

test("chat file links and composer file chips have their main-stack destination without excluded tools", () => {
  const main = stacks.find((stack) => stack.initialRouteName === "Home");
  expect(main.screens.ThreadFile).toBeDefined();
  expect(Object.keys(main.screens)).not.toContain("Review");
  expect(Object.keys(main.screens)).not.toContain("ThreadTerminal");
});
test.each(["completed", "failed"])(
  "notification tap opens an idle connected native %s project without Start",
  async (category) => {
    tasks = [task("native", "t3")];
    const payload = {
      category,
      serverId: host.serverId,
      installationId: "22222222-2222-4222-8222-222222222222",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      target: { kind: "t3", environmentId: "native", projectId: "project", conversationId: "one" },
    };
    await flush(() =>
      notice({
        url: `sandbox-companion://notification?payload=${encodeURIComponent(JSON.stringify(payload))}`,
      }),
    );
    expect(openView).toHaveBeenCalledWith(host, {
      kind: "t3",
      environmentId: "native",
      projectId: "project",
      conversationId: "one",
      openIntent: "open",
    });
    expect(phone.error).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  },
);
test("disconnected notification target stays unavailable without Start or conversation navigation", async () => {
  tasks = [{ ...task("native", "t3"), connection: "disconnected" } as PhoneTask];
  const payload = {
    serverId: host.serverId,
    installationId: "22222222-2222-4222-8222-222222222222",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    target: { kind: "t3", environmentId: "native", projectId: "project", conversationId: "one" },
  };
  await flush(() =>
    notice({
      url: `sandbox-companion://notification?payload=${encodeURIComponent(JSON.stringify(payload))}`,
    }),
  );
  expect(openView).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(phone.error).not.toContain("Start");
  expect(navigate).not.toHaveBeenCalledWith("Thread", expect.anything());
});
test("a finishing Start opens its original conversation when selection has not changed", async () => {
  await flush(() => phone.invoke(tasks[0]!, "start", {}));
  await flush(complete);
  expect(openView).toHaveBeenCalledWith(host, {
    kind: "sandbox",
    taskId: "A",
    stableId: "A",
    conversationId: "one",
    openIntent: "open",
  });
});
test.each(["open another task", "go Home", "switch conversation"])(
  "a finishing Start cannot steal selection after %s",
  async (action) => {
    if (action === "switch conversation") await flush(() => phone.open(tasks[1]!, "one"));
    await flush(() => phone.invoke(tasks[0]!, "start", {}));
    if (action === "open another task") await flush(() => phone.open(tasks[1]!, "one"));
    else if (action === "go Home")
      await flush(() => onStateChange({ index: 0, routes: [{ name: "Home" }] }));
    else
      await flush(() =>
        onStateChange({
          index: 0,
          routes: [{ name: "Thread", params: { environmentId: "B", threadId: "two" } }],
        }),
      );
    openView.mockClear();
    await flush(complete);
    expect(openView).not.toHaveBeenCalled();
  },
);
test("an invocation accepted after going Home cannot install a stale pending launch", async () => {
  let resolve!: (result: unknown) => void;
  invoke = vi.fn(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<void>;
  await flush(() => {
    pending = phone.invoke(tasks[0]!, "start", {});
  });
  await flush(() => onStateChange({ index: 0, routes: [{ name: "Home" }] }));
  await flush(() => {
    resolve({ launch: { conversationId: "one" }, operation: { id: "start-operation" } });
    return pending;
  });
  await flush(complete);
  expect(openView).not.toHaveBeenCalled();
});
