import * as NodeModule from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const requireFromMobile = NodeModule.createRequire(import.meta.url);
const observeModulePath = requireFromMobile.resolve("expo-observe");
const originalObserveModule = requireFromMobile.cache[observeModulePath];

function mockObserve(load: () => unknown) {
  const module = new NodeModule.Module(observeModulePath);
  module.loaded = true;
  Object.defineProperty(module, "exports", { get: load });
  requireFromMobile.cache[observeModulePath] = module;
}

const state = vi.hoisted(() => ({
  extra: {} as { relay?: { url?: unknown }; appVariant?: unknown },
  configure: vi.fn(),
  dispatchEvents: vi.fn<() => Promise<void>>(),
  reportError: vi.fn(),
  loadPreferences: vi.fn<() => Promise<{ crashReportsEnabled: boolean }>>(),
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      get extra() {
        return state.extra;
      },
    },
  },
}));
vi.mock("expo-observe", () => {
  throw new Error("Project ID is required to send observability metrics");
});
vi.mock("../../persistence/imperative", () => ({ loadPreferences: state.loadPreferences }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.extra = {};
  state.dispatchEvents.mockResolvedValue(undefined);
  state.loadPreferences.mockResolvedValue({ crashReportsEnabled: false });
  vi.stubGlobal("__DEV__", false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalObserveModule) requireFromMobile.cache[observeModulePath] = originalObserveModule;
  else delete requireFromMobile.cache[observeModulePath];
});

it.each([undefined, "", "   ", 42])(
  "does not initialize Observe without a configured relay (%s)",
  async (url) => {
    state.extra = { relay: { url } };
    const requireObserve = vi.fn(() => {
      throw new Error("Project ID is required to send observability metrics");
    });
    const trackRejections = vi.fn();
    mockObserve(requireObserve);
    vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: trackRejections });

    const observe = await import("./observe");
    observe.reportError(new Error("caught render failure"));
    await observe.setCrashReportsEnabled(true);
    await observe.setCrashReportsEnabled(false);

    expect(observe.crashReportingAvailable).toBe(false);
    expect(requireObserve).not.toHaveBeenCalled();
    expect(state.loadPreferences).not.toHaveBeenCalled();
    expect(trackRejections).not.toHaveBeenCalled();
  },
);

it("loads Observe for a configured relay and preserves saved preferences and rejection reporting", async () => {
  state.extra = { relay: { url: "https://relay.example.test" }, appVariant: "production" };
  const requireObserve = vi.fn(() => ({ Observe: state }));
  const trackRejections = vi.fn();
  mockObserve(requireObserve);
  vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: trackRejections });
  const configured = Promise.withResolvers<void>();
  state.configure.mockImplementation(() => configured.resolve());

  const observe = await import("./observe");
  await configured.promise;
  expect(observe.crashReportingAvailable).toBe(true);
  expect(requireObserve).toHaveBeenCalled();
  expect(state.configure).toHaveBeenCalledWith({
    dispatchingEnabled: false,
    environment: "production",
  });
  expect(state.dispatchEvents).not.toHaveBeenCalled();
  const tracker = trackRejections.mock.calls[0]?.[0];
  const caught = new Error("caught render failure");
  observe.reportError(caught);
  expect(state.reportError).toHaveBeenCalledWith(caught);
  const rejection = new Error("unhandled rejection");
  tracker.onUnhandled(1, rejection);
  expect(state.reportError).toHaveBeenCalledWith(rejection);

  await observe.setCrashReportsEnabled(true);
  expect(state.dispatchEvents).toHaveBeenCalledOnce();
  expect(state.configure).toHaveBeenLastCalledWith({
    dispatchingEnabled: true,
    environment: "production",
  });
});

it("does not let the initial preference overwrite a newer explicit choice", async () => {
  state.extra = { relay: { url: "https://relay.example.test" } };
  mockObserve(() => ({ Observe: state }));
  const preference = Promise.withResolvers<{ crashReportsEnabled: boolean }>();
  state.loadPreferences.mockReturnValue(preference.promise);
  const observe = await import("./observe");
  await observe.setCrashReportsEnabled(false);
  preference.resolve({ crashReportsEnabled: true });
  await vi.dynamicImportSettled();

  expect(state.configure).toHaveBeenCalledExactlyOnceWith({ dispatchingEnabled: false });
  expect(state.dispatchEvents).not.toHaveBeenCalled();
});
