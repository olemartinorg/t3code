import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  SettingsEnvironmentFilterProvider,
  useSettingsEnvironmentFilter,
} from "../features/settings/settings-environment-filter";
import { SettingsEnvironmentNewThreadsRouteScreen } from "../features/settings/SettingsServerControlsRouteScreen";
import { currentNativeView } from "./transport";
function SelectedScope() {
  const [ready, setReady] = useState(false);
  const view = currentNativeView();
  const { projectGroups, selectedProjectKey, selectProject } = useSettingsEnvironmentFilter();
  const projectId = view?.session.projectId ?? null;
  const group =
    projectId === null
      ? null
      : projectGroups.find((group) =>
          group.members.some(
            (member) =>
              member.project.environmentId === view?.session.environmentId &&
              member.project.id === projectId,
          ),
        );
  const key = group?.key ?? null;
  useEffect(() => {
    if (!ready && (projectId === null || group)) {
      selectProject(key);
      setReady(true);
    }
  }, [ready, projectId, group, key, selectProject]);
  if (!view || !ready)
    return (
      <View className="flex-1 bg-screen">
        <Text style={{ color: "#fff" }}>Loading selected project settings…</Text>
      </View>
    );
  return <SettingsEnvironmentNewThreadsRouteScreen />;
}
export function SettingsScope() {
  const view = currentNativeView();
  return (
    <SettingsEnvironmentFilterProvider
      key={`${view?.session.environmentId}:${view?.session.projectId}`}
    >
      <SelectedScope />
    </SettingsEnvironmentFilterProvider>
  );
}
