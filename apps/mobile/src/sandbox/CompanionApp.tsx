import { RegistryContext } from "@effect/atom-react";
import { createStaticNavigation, createNavigationContainerRef } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import { EventCursor, SandboxApiClient } from "sandbox/client";
import { notificationPayloadSchema } from "sandbox/contracts";
import { appAtomRegistry } from "../state/atom-registry";
import { AppearancePreferencesProvider } from "../features/settings/appearance/AppearancePreferencesProvider";
import { VoiceInputProvider } from "../features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "../features/voice-input/GlobalVoiceInputControl";
import { IncomingShareProvider } from "../features/sharing/IncomingShareProvider";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { OverlayPortalHost } from "../components/OverlayPortal";
import { ThreadArrangementHost } from "../features/threads/ThreadArrangementSheet";
import { HardwareKeyboardCommandProvider } from "../features/keyboard/HardwareKeyboardCommandProvider";
import {
  ExistingThreadSettingsRouteProvider,
  ExistingThreadSettingsRouteScreen,
  NewTaskThreadSettingsRouteScreen,
} from "../features/threads/ThreadSettingsSheet";
import { ThreadRouteScreen } from "../features/threads/ThreadRouteScreen";
import { ThreadAgentsSheet } from "../features/threads/ThreadAgentsSheet";
import { ThreadQueueSheet } from "../features/threads/ThreadQueueControl";
import { NewTaskDraftRouteScreen } from "../features/threads/NewTaskDraftRouteScreen";
import { NewTaskFlowProvider } from "../features/threads/new-task-flow-provider";
import { AttachmentFileScreen } from "../features/files/AttachmentFileScreen";
import {
  SettingsOpenSourceLicenseRouteScreen,
  SettingsOpenSourceLicensesRouteScreen,
} from "../features/settings/SettingsOpenSourceLicensesRouteScreen";
import { SettingsLegalRouteScreen } from "../features/settings/SettingsLegalRouteScreen";
import { SettingsScope } from "./SettingsScope";
import {
  NewTaskBranchPickerRouteScreen,
  NewTaskEnvironmentPickerRouteScreen,
} from "../features/threads/NewTaskContextPickerScreens";
import { ThreadFileScreen } from "../features/files/ThreadFilesRouteScreen";
import { SettingsEnvironmentFilterProvider } from "../features/settings/settings-environment-filter";
import { useThreadOutboxDrain } from "../state/use-thread-outbox-drain";
import { useComposerAttachmentUploadWorker } from "../state/composer-attachment-uploads";
import { useMobileNavigationTheme } from "../lib/useMobileNavigationTheme";
import { PhoneContext } from "./phone-context";
import { Home } from "./Home";
import {
  applyPhoneFrame,
  emptyPhoneState,
  portableTaskTarget,
  phoneAgentAvailability,
  samePhoneTarget,
  type PhoneTask,
} from "./model";
import { readPhoneHosts, savePhoneHosts, installationId } from "./profiles";
import { closePhoneView, openPhoneView, type PhoneHost } from "./view-controller";
import { Notices } from "./Notices";
import { nativeSandbox, trustedOrigin, currentNativeView } from "./transport";
import { setPhoneReconnect } from "./reconnect";

const navigation = createNavigationContainerRef();
function Workers() {
  useThreadOutboxDrain();
  useComposerAttachmentUploadWorker();
  return null;
}
const DraftStack = createNativeStackNavigator({
  initialRouteName: "NewTaskDraft",
  screens: {
    NewTaskDraft: createNativeStackScreen({ screen: NewTaskDraftRouteScreen }),
    ThreadSettings: createNativeStackScreen({ screen: NewTaskThreadSettingsRouteScreen }),
    NewTaskAttachment: createNativeStackScreen({ screen: AttachmentFileScreen }),
    NewTaskBranch: createNativeStackScreen({ screen: NewTaskBranchPickerRouteScreen }),
    NewTaskEnvironment: createNativeStackScreen({ screen: NewTaskEnvironmentPickerRouteScreen }),
    NewTaskFile: createNativeStackScreen({ screen: ThreadFileScreen }),
  },
});
const SettingsContent = createNativeStackNavigator({
  screens: {
    SettingsEnvironmentNewThreads: createNativeStackScreen({ screen: SettingsScope }),
    SettingsOpenSourceLicenses: createNativeStackScreen({
      screen: SettingsOpenSourceLicensesRouteScreen,
    }),
    SettingsOpenSourceLicense: createNativeStackScreen({
      screen: SettingsOpenSourceLicenseRouteScreen,
    }),
  },
});
const SettingsStack = createNativeStackNavigator({
  screens: { SettingsContent: createNativeStackScreen({ screen: SettingsContent }) },
});
const Stack = createNativeStackNavigator({
  initialRouteName: "Home",
  layout: ({ children }) => (
    <HardwareKeyboardCommandProvider pathname="/">
      <Workers />
      <ExistingThreadSettingsRouteProvider>{children}</ExistingThreadSettingsRouteProvider>
    </HardwareKeyboardCommandProvider>
  ),
  screenOptions: { headerShown: false },
  screens: {
    Home: createNativeStackScreen({ screen: Home }),
    Thread: createNativeStackScreen({ screen: ThreadRouteScreen }),
    ThreadSettingsSheet: createNativeStackScreen({ screen: ExistingThreadSettingsRouteScreen }),
    ThreadQueue: createNativeStackScreen({ screen: ThreadQueueSheet }),
    ThreadAgents: createNativeStackScreen({ screen: ThreadAgentsSheet }),
    ThreadAttachment: createNativeStackScreen({ screen: AttachmentFileScreen }),
    ThreadFile: createNativeStackScreen({ screen: ThreadFileScreen }),
    NewTaskSheet: createNativeStackScreen({
      screen: DraftStack,
      layout: ({ children }) => (
        <NewTaskFlowProvider>
          <View className="flex-1 bg-screen">{children}</View>
        </NewTaskFlowProvider>
      ),
    }),
    SettingsSheet: createNativeStackScreen({
      screen: SettingsStack,
      layout: ({ children }) => (
        <SettingsEnvironmentFilterProvider>{children}</SettingsEnvironmentFilterProvider>
      ),
    }),
    SettingsLegal: createNativeStackScreen({ screen: Notices }),
    SettingsOpenSourceLicenses: createNativeStackScreen({
      screen: SettingsOpenSourceLicensesRouteScreen,
    }),
    SettingsOpenSourceLicense: createNativeStackScreen({
      screen: SettingsOpenSourceLicenseRouteScreen,
    }),
  },
});
const Navigation = createStaticNavigation(Stack);

function Phone() {
  const [hosts, setHosts] = useState<PhoneHost[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const host = hosts.find((item) => item.serverId === selected) ?? null;
  const client = useMemo(
    () => (host ? new SandboxApiClient(host.origin, host.token) : null),
    [host],
  );
  const [permission, setPermission] = useState("unknown");
  const [notificationStatus, setNotificationStatus] = useState<Awaited<
    ReturnType<SandboxApiClient["notificationStatus"]>
  > | null>(null);
  const [state, setState] = useState(emptyPhoneState),
    [connected, setConnected] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<{
    generation: number;
    operationId: string;
    taskId: string;
    serverId: string;
    conversationId: string | null;
  } | null>(null);
  const [cursor, page] = useState<string | null>(null),
    [epoch, refresh] = useState(0),
    [foreground, setForeground] = useState(AppState.currentState === "active");
  const route = useRef<{
    host: PhoneHost;
    task: PhoneTask;
    conversationId: string | null;
    intent: "open" | "new-conversation" | "settings";
  } | null>(null);
  const navigationGeneration = useRef(0);
  const theme = useMobileNavigationTheme();
  const persist = useCallback(async (next: PhoneHost[]) => {
    await savePhoneHosts(next);
    setHosts(next);
    nativeSandbox().configureSandboxNotifications(
      await installationId(),
      Object.fromEntries(next.map((item) => [item.serverId, item.notifications])),
    );
  }, []);
  useEffect(() => {
    void readPhoneHosts()
      .then(async (next) => {
        setHosts(next);
        setSelected(next[0]?.serverId ?? null);
        nativeSandbox().configureSandboxNotifications(
          await installationId(),
          Object.fromEntries(next.map((item) => [item.serverId, item.notifications])),
        );
      })
      .catch(() => setError("Saved hosts could not be loaded"));
    void SplashScreen.hideAsync();
  }, []);
  const open = useCallback(
    async (
      task: PhoneTask,
      conversationId: string | null,
      intent: "open" | "new-conversation" | "settings" = "open",
    ) => {
      if (!host) return;
      if (!client) return;
      setPendingLaunch(null);
      const intentGeneration = ++navigationGeneration.current;
      const current = (await client.tasks()).tasks.find((candidate) =>
        samePhoneTarget(task, candidate),
      );
      if (intentGeneration !== navigationGeneration.current) return;
      if (!current) throw new Error("This task or native project is no longer available");
      if (intent === "open" && conversationId === null && current.conversations.length > 1) {
        navigation.navigate("Home");
        Alert.alert("Choose conversation", "Select the conversation listed under this task.");
        return;
      }
      if (intent === "open" && conversationId === null && current.conversations.length === 1)
        conversationId = current.conversations[0]!.id;
      route.current = { host, task: current, conversationId, intent };
      const view = await openPhoneView(
        host,
        portableTaskTarget(current, conversationId, intent),
      ).catch((cause) => {
        if (intentGeneration !== navigationGeneration.current) return null;
        throw cause;
      });
      if (!view) return;
      if (intentGeneration !== navigationGeneration.current || !navigation.isReady()) return;
      if (intent === "settings")
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironmentNewThreads" },
        });
      else if (view.session.conversationId)
        navigation.navigate("Thread", {
          environmentId: view.session.environmentId,
          threadId: view.session.conversationId,
        });
      else
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: view.session.environmentId,
            projectId: view.session.projectId ?? undefined,
          },
        });
    },
    [host, client],
  );
  useEffect(() => {
    setPhoneReconnect(async () => {
      const current = route.current;
      if (current && current.host.serverId === selected)
        await open(current.task, current.conversationId, current.intent);
    });
    return () => setPhoneReconnect(null);
  }, [open, selected]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (phase) => {
      const active = phase === "active";
      setForeground(active);
      if (!active) {
        navigationGeneration.current++;
        void closePhoneView();
      } else {
        const current = route.current;
        if (current && current.host.serverId === selected)
          void open(current.task, current.conversationId, current.intent).catch(() =>
            setError("Reconnect to the PC to continue"),
          );
      }
    });
    return () => listener.remove();
  }, [open, selected]);
  useEffect(() => {
    let live = true,
      socket: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | null = null;
    setConnected(false);
    if (!host || !client || !foreground) return;
    nativeSandbox().selectSandboxHost(host.origin);
    const connect = async () => {
      try {
        const identity = await client.identity();
        if (identity.serverId !== host.serverId)
          throw new Error("The PC service identity changed; configure it again");
        const current = await client.connectEvents({
          cursor: new EventCursor(),
          subscriptions: [
            { topic: "tasks", scope: "active" },
            { topic: "tasks", scope: "history", pageSize: 50, cursor },
            { topic: "github" },
            { topic: "projects" },
            { topic: "operations" },
          ],
          onEvent: (frame) => {
            if (!live) return;
            if (frame.serverId !== host.serverId) {
              setError("PC identity changed");
              socket?.close();
              return;
            }
            setConnected(true);
            setError(null);
            setState((previous) => applyPhoneFrame(previous, frame));
          },
          onClose: () => {
            if (live) {
              setConnected(false);
              timer = setTimeout(() => void connect(), 3000);
            }
          },
          onError: () => {
            if (live) setError("PC connection unavailable; last valid state retained");
          },
        });
        if (!live) current.close();
        else socket = current;
      } catch {
        if (live) {
          setConnected(false);
          setError("Reconnect to the trusted LAN PC");
          timer = setTimeout(() => void connect(), 3000);
        }
      }
    };
    void connect();
    return () => {
      live = false;
      socket?.close();
      if (timer) clearTimeout(timer);
    };
  }, [host, client, foreground, cursor, epoch]);
  const invoke = async (task: PhoneTask, actionId: string, input: Record<string, unknown>) => {
    if (!client || !host) return;
    const intentGeneration = navigationGeneration.current;
    const result = await client.invokeTask(task.id, actionId, input, randomUUID());
    if (!result.launch || intentGeneration !== navigationGeneration.current) return;
    if (result.operation)
      setPendingLaunch({
        generation: intentGeneration,
        operationId: result.operation.id,
        taskId: task.id,
        serverId: host.serverId,
        conversationId: result.launch.conversationId,
      });
    else await open(task, result.launch.conversationId, result.launch.agentIntent ?? "open");
  };
  useEffect(() => {
    if (!pendingLaunch) return;
    if (
      pendingLaunch.serverId !== host?.serverId ||
      pendingLaunch.generation !== navigationGeneration.current
    ) {
      setPendingLaunch(null);
      return;
    }
    const operation = state.operations.find((item) => item.id === pendingLaunch.operationId);
    if (!operation || operation.state === "queued" || operation.state === "running") return;
    setPendingLaunch(null);
    if (operation.state !== "succeeded") return;
    const task = state.active.find((item) => item.id === pendingLaunch.taskId);
    if (task?.presentation.running)
      void open(task, pendingLaunch.conversationId).catch(() =>
        setError("Task started; select its conversation to continue"),
      );
  }, [pendingLaunch, state, host, open]);
  useEffect(() => {
    const current = route.current;
    if (
      !connected ||
      !foreground ||
      !current ||
      current.host.serverId !== host?.serverId ||
      currentNativeView()
    )
      return;
    void open(current.task, current.conversationId, current.intent).catch(() =>
      setError("Conversation unavailable after reconnect; select its normal action."),
    );
  }, [connected, foreground, host, open]);
  const addHost = async (name: string, origin: string, token: string) => {
    navigationGeneration.current++;
    if (!name.trim() || name.length > 80 || !token || token.length > 8192 || /[\r\n]/.test(token))
      throw new Error("Enter a connection name and valid Sandbox bearer key");
    origin = trustedOrigin(origin);
    nativeSandbox().selectSandboxHost(origin);
    const api = new SandboxApiClient(origin, token),
      identity = await api.identity();
    await persist([
      ...hosts.filter((item) => item.serverId !== identity.serverId),
      { serverId: identity.serverId, name, origin, token, notifications: false },
    ]);
    setSelected(identity.serverId);
    setState(emptyPhoneState());
    page(null);
  };
  const notificationSetup = async () => {
    if (!host || !client) return;
    if (Constants.expoConfig?.extra?.androidPushConfigured !== true) {
      Alert.alert(
        "Push setup pending",
        "LAN controls and conversations work in this APK. Install a push-enabled build after Firebase setup before enabling phone notifications.",
      );
      return;
    }
    const result = await Notifications.requestPermissionsAsync();
    setPermission(result.status);
    if (!result.granted) {
      Alert.alert(
        "Notifications disabled",
        "Allow Android notification permission before enabling this phone.",
      );
      return;
    }
    const token = await Notifications.getDevicePushTokenAsync();
    await client.registerPhone(await installationId(), {
      serverId: host.serverId,
      token: String(token.data),
      enabled: true,
      permission: "granted",
    });
    await persist(
      hosts.map((item) =>
        item.serverId === host.serverId ? { ...item, notifications: true } : item,
      ),
    );
    setNotificationStatus(await client.notificationStatus());
  };
  useEffect(() => {
    let live = true;
    if (!host || !client || !foreground) {
      setNotificationStatus(null);
      return;
    }
    void Notifications.getPermissionsAsync()
      .then((value) => {
        if (live) setPermission(value.status);
      })
      .catch(() => {
        if (live) setPermission("unavailable");
      });
    if (connected)
      void client.notificationStatus().then(
        (value) => {
          if (live) setNotificationStatus(value);
        },
        () => {
          if (live) setNotificationStatus(null);
        },
      );
    return () => {
      live = false;
    };
  }, [host, client, foreground, connected]);
  useEffect(() => {
    if (!host || !client || !foreground) return;
    let live = true;
    const update = async (value?: string) => {
      const permission = await Notifications.getPermissionsAsync();
      if (live) setPermission(permission.status);
      const token = value ?? String((await Notifications.getDevicePushTokenAsync()).data);
      if (!live) return;
      await client.registerPhone(await installationId(), {
        serverId: host.serverId,
        token,
        enabled: host.notifications,
        permission: permission.granted
          ? "granted"
          : permission.status === "undetermined"
            ? "undetermined"
            : "denied",
      });
    };
    const listener = Notifications.addPushTokenListener((token) => {
      void update(String(token.data)).catch(() => {
        if (live) setError("Notification token update waits for the LAN");
      });
    });
    if (host.notifications)
      void update().catch(() => {
        if (live) setError("Notification permission/token update waits for the LAN");
      });
    return () => {
      live = false;
      listener.remove();
    };
  }, [host, client, foreground]);
  useEffect(() => {
    let live = true;
    const follow = async (url: string) => {
      const intentGeneration = ++navigationGeneration.current;
      try {
        const link = new URL(url);
        if (link.protocol !== "sandbox-companion:" || link.hostname !== "notification") return;
        const payload = notificationPayloadSchema.parse(
          JSON.parse(link.searchParams.get("payload") ?? "null"),
        );
        const targetHost = hosts.find(
          (item) => item.serverId === payload.serverId && item.notifications,
        );
        if (
          !targetHost ||
          payload.installationId !== (await installationId()) ||
          Date.parse(payload.expiresAt) < Date.now()
        )
          throw new Error("Notification expired or this host is disabled");
        if (!live || intentGeneration !== navigationGeneration.current) return;
        nativeSandbox().selectSandboxHost(targetHost.origin);
        const api = new SandboxApiClient(targetHost.origin, targetHost.token);
        if ((await api.identity()).serverId !== targetHost.serverId)
          throw new Error("PC identity changed");
        const target = payload.target;
        const tasks = (await api.tasks()).tasks;
        const task = tasks.find((item) =>
          target.kind === "sandbox"
            ? item.kind === "sandbox" && item.stableId === target.stableId
            : item.kind === "t3" &&
              item.environmentId === target.environmentId &&
              item.projectId === target.projectId,
        );
        if (!task || !task.conversations.some((item) => item.id === target.conversationId))
          throw new Error("Conversation is no longer available");
        if (!live || intentGeneration !== navigationGeneration.current) return;
        setSelected(targetHost.serverId);
        route.current = {
          host: targetHost,
          task,
          conversationId: target.conversationId,
          intent: "open",
        };
        if (!phoneAgentAvailability(task).open) {
          navigation.navigate("Home");
          setError("Conversation unavailable. Reconnect to the PC and use its normal actions.");
          return;
        }
        const view = await openPhoneView(
          targetHost,
          portableTaskTarget(task, target.conversationId),
        );
        if (live && intentGeneration === navigationGeneration.current)
          navigation.navigate("Thread", {
            environmentId: view.session.environmentId,
            threadId: target.conversationId,
          });
        else if (currentNativeView() === view) await closePhoneView();
      } catch {
        if (!live || intentGeneration !== navigationGeneration.current) return;
        setError(
          "Notification could not be opened. Reconnect to the PC and select the conversation.",
        );
      }
    };
    const listener = Linking.addEventListener("url", (event) => void follow(event.url));
    void Linking.getInitialURL().then((url) => {
      if (url) void follow(url);
    });
    return () => {
      live = false;
      listener.remove();
    };
  }, [hosts]);
  const value = {
    host,
    hosts,
    client,
    connected,
    state,
    error,
    addHost,
    selectHost: (id: string) => {
      navigationGeneration.current++;
      route.current = null;
      setPendingLaunch(null);
      void closePhoneView();
      setSelected(id);
      setState(emptyPhoneState());
      page(null);
    },
    removeHost: async () => {
      if (!host) return;
      navigationGeneration.current++;
      route.current = null;
      await closePhoneView();
      await persist(hosts.filter((item) => item.serverId !== host.serverId));
      setSelected(null);
      setState(emptyPhoneState());
      await client
        ?.removePhone(await installationId())
        .catch(() =>
          setError("Phone muted locally. The PC registration can be removed when it is reachable."),
        );
      nativeSandbox().selectSandboxHost(null);
    },
    open,
    invoke,
    page,
    refresh: () => refresh((value) => value + 1),
    notificationSetup,
    permission,
    notificationStatus,
    muted: !host?.notifications,
    setMuted: async (muted: boolean) => {
      if (!host) return;
      if (!muted) {
        await notificationSetup();
        return;
      }
      await persist(
        hosts.map((item) =>
          item.serverId === host.serverId ? { ...item, notifications: false } : item,
        ),
      );
      {
        const permission = await Notifications.getPermissionsAsync();
        const token = await Notifications.getDevicePushTokenAsync();
        await client?.registerPhone(await installationId(), {
          serverId: host.serverId,
          token: String(token.data),
          enabled: false,
          permission: permission.granted ? "granted" : "denied",
        });
      }
    },
  };
  return (
    <PhoneContext.Provider value={value}>
      <Navigation
        ref={navigation}
        theme={theme}
        onStateChange={(state) => {
          const top = state?.routes[state.index];
          if (top?.name === "Home") {
            setPendingLaunch(null);
            navigationGeneration.current++;
            route.current = null;
            void closePhoneView();
          } else if (top?.name === "Thread") {
            const params = top.params as { environmentId?: string; threadId?: string } | undefined;
            const current = route.current;
            if (
              current &&
              params?.threadId &&
              params.environmentId === currentNativeView()?.session.environmentId
            ) {
              if (current.conversationId !== params.threadId) {
                setPendingLaunch(null);
                navigationGeneration.current++;
              }
              current.conversationId = params.threadId;
              current.intent = "open";
              const target = portableTaskTarget(current.task, params.threadId);
              const { openIntent: _intent, ...identity } = target;
              nativeSandbox().setSandboxThreadOnScreen(
                current.host.serverId,
                JSON.stringify(identity),
              );
            }
          }
        }}
      />
    </PhoneContext.Provider>
  );
}
export default function CompanionApp() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <GestureHandlerRootView className="flex-1">
          <KeyboardProvider>
            <SafeAreaProvider>
              <VoiceInputProvider>
                <GlobalVoiceInputControl>
                  <IncomingShareProvider>
                    <StatusBar barStyle="light-content" />
                    <Phone />
                  </IncomingShareProvider>
                  <ConfirmDialogHost />
                  <ThreadArrangementHost />
                </GlobalVoiceInputControl>
                <OverlayPortalHost />
              </VoiceInputProvider>
            </SafeAreaProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}
