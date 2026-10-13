// @vitest-environment jsdom
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  context: undefined as unknown,
  persistServer: vi.fn(),
  persistClient: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => state.context,
  useOptionalSettingsScope: () => state.context,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.persistServer }));
vi.mock("../../hooks/useSettings", () => ({
  persistClientSettingsPatch: state.persistClient,
  useClientSettings: () => ({}),
  mergeEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

import { resolveSettingsScope } from "./settingsScope";
import { useUpdateScopedSettings } from "./useScopedSettings";

const environmentId = EnvironmentId.make("native-environment");
const environment = {
  environmentId,
  label: "Native environment",
  connection: { phase: "connected" as const },
  serverConfig: {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { capabilities: { projectSettingsOverrides: true } },
  },
};
let renderer: ReactTestRenderer | undefined;
let update: ReturnType<typeof useUpdateScopedSettings>;
function SettingsReader() {
  update = useUpdateScopedSettings();
  return null;
}

beforeEach(() => {
  state.persistServer.mockReset().mockResolvedValue({ _tag: "Success" });
  state.persistClient.mockReset();
  state.toast.mockReset();
  state.context = {
    scope: resolveSettingsScope({ machine: environmentId }, [], [environment]),
    environments: [environment],
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  delete window.sandboxT3;
});

async function save(targetKind: "managed-task" | "external-t3" | undefined) {
  const saveModelDefault = vi.fn().mockResolvedValue({ saved: true });
  window.sandboxT3 = {
    version: 1,
    targetKind,
    getVisible: () => true,
    onVisibility: () => () => {},
    getEnvironmentId: () => environmentId,
    saveModelDefault,
  };
  await act(async () => {
    renderer = create(<SettingsReader />);
  });
  await update({ defaultModelSelection: null });
  return saveModelDefault;
}

test.each([undefined, "external-t3"] as const)(
  "%s targets save native settings without changing future guest defaults",
  async (targetKind) => {
    const template = await save(targetKind);
    expect(state.persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { defaultModelSelection: null } },
    });
    expect(template).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  },
);
test("a confirmed managed task model change saves the future task template", async () => {
  const template = await save("managed-task");
  expect(template).toHaveBeenCalledExactlyOnceWith(environmentId, null);
});
test("a failed native managed task save cannot change the future template", async () => {
  state.persistServer.mockResolvedValue({ _tag: "Failure" });
  const template = await save("managed-task");
  expect(template).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Setting not saved" }));
});
