import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import {
  Alert,
  Button,
  Linking,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { randomUUID } from "expo-crypto";
import type { PhoneTask } from "./model";
import { usePhone } from "./phone-context";

type Action = PhoneTask["presentation"]["actions"][number];
const text = { color: "#e4e4e7" };
function ActionControl({
  task,
  action,
  parentEnabled = true,
}: {
  task: PhoneTask;
  action: Action;
  parentEnabled?: boolean;
}) {
  const phone = usePhone(),
    [input, setInput] = useState<Record<string, string>>({}),
    [pending, setPending] = useState(false);
  const run = async () => {
    if (!phone.client) return;
    const values: Record<string, unknown> = {};
    for (const field of action.inputs) {
      const value =
        input[field.name] ?? (field.type === "select" ? field.choices[0]?.value : "") ?? "";
      if (field.required && !value) {
        Alert.alert("Input required", field.label);
        return;
      }
      try {
        values[field.name] = field.type === "json" && value ? JSON.parse(value) : value;
      } catch {
        Alert.alert("Invalid JSON", field.label);
        return;
      }
    }
    setPending(true);
    try {
      await phone.invoke(
        task,
        action.id,
        action.id === "archive" ? { ...values, discard: true } : values,
      );
    } catch (cause) {
      Alert.alert(
        "Action unavailable",
        cause instanceof Error ? cause.message : "Reconnect and refresh",
      );
    } finally {
      setPending(false);
    }
  };
  if (action.kind === "compound")
    return (
      <View style={{ borderColor: "#52525b", borderWidth: 1, padding: 8 }}>
        <Text style={text}>{action.label}</Text>
        {action.reason && <Text style={text}>{action.reason}</Text>}
        {action.actions.map((child) => (
          <ActionControl
            key={child.id}
            task={task}
            action={child}
            parentEnabled={parentEnabled && action.enabled}
          />
        ))}
      </View>
    );
  return (
    <View style={{ gap: 6 }}>
      {action.inputs.map((field) => (
        <View key={field.name}>
          <Text style={text}>{field.label}</Text>
          {field.type === "select" ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {field.choices.map((choice) => (
                <Button
                  key={choice.value}
                  title={`${(input[field.name] ?? field.choices[0]?.value) === choice.value ? "✓ " : ""}${choice.label}`}
                  onPress={() =>
                    setInput((previous) => ({ ...previous, [field.name]: choice.value }))
                  }
                />
              ))}
            </View>
          ) : (
            <TextInput
              style={{ ...text, borderColor: "#71717a", borderWidth: 1 }}
              value={input[field.name] ?? ""}
              onChangeText={(value) =>
                setInput((previous) => ({ ...previous, [field.name]: value }))
              }
            />
          )}
        </View>
      ))}
      <Button
        title={pending ? `${action.label}…` : action.label}
        disabled={!phone.connected || !parentEnabled || !action.enabled || pending}
        onPress={() =>
          action.confirmation
            ? Alert.alert(action.label, action.confirmation, [
                { text: "Cancel", style: "cancel" },
                { text: action.label, style: "destructive", onPress: () => void run() },
              ])
            : void run()
        }
      />
      {action.reason && <Text style={text}>{action.reason}</Text>}
    </View>
  );
}
function TaskCard({ task }: { task: PhoneTask }) {
  const phone = usePhone(),
    failure = (cause: unknown) =>
      Alert.alert("Cannot open conversation", cause instanceof Error ? cause.message : "Reconnect");
  return (
    <View style={{ padding: 12, borderColor: "#52525b", borderWidth: 1, gap: 8 }}>
      <Text style={{ ...text, fontSize: 20 }}>{task.name}</Text>
      <Text style={text}>
        {task.presentation.status.label} · {task.presentation.summary}
      </Text>
      {task.presentation.errors.map((error, index) => (
        <Text key={index} style={{ color: "#fca5a5" }}>
          {error}
        </Text>
      ))}
      {task.presentation.notices.map((notice, index) => (
        <Text key={index} style={text}>
          {notice}
        </Text>
      ))}
      {task.presentation.progress && (
        <Text style={text}>
          {task.presentation.progress.label}: {task.presentation.progress.text} (
          {Math.round(task.presentation.progress.fraction * 100)}%)
        </Text>
      )}
      {task.presentation.actions.map((action) => (
        <ActionControl key={action.id} task={task} action={action} />
      ))}
      {task.conversations.map((conversation) => (
        <Button
          key={conversation.id}
          title={`${conversation.unread ? "● " : ""}${conversation.title} · ${conversation.status}`}
          disabled={!phone.connected || !task.presentation.running}
          onPress={() => void phone.open(task, conversation.id).catch(failure)}
        />
      ))}
      {task.presentation.running && (
        <>
          <Button
            title="New conversation"
            disabled={!phone.connected}
            onPress={() => void phone.open(task, null, "new-conversation").catch(failure)}
          />
          <Button
            title="New-conversation settings"
            disabled={!phone.connected}
            onPress={() => void phone.open(task, null, "settings").catch(failure)}
          />
        </>
      )}
    </View>
  );
}
export function Home() {
  const navigation = useNavigation();
  const phone = usePhone(),
    [tab, setTab] = useState<"active" | "history" | "prs" | "hosts">("active");
  const [name, setName] = useState(""),
    [origin, setOrigin] = useState(""),
    [token, setToken] = useState(""),
    [taskName, setTaskName] = useState(""),
    [projectId, setProjectId] = useState("");
  const failure = (cause: unknown) =>
      Alert.alert(
        "Sandbox",
        cause instanceof Error ? cause.message : "The request could not complete",
      ),
    page = phone.state.historyPage;
  return (
    <ScrollView
      style={{ backgroundColor: "#09090b" }}
      contentContainerStyle={{ padding: 18, paddingTop: 36, gap: 12 }}
    >
      <Text style={{ color: "#fff", fontSize: 26 }}>
        Sandbox · {phone.host?.name ?? "Choose PC"}
      </Text>
      <Text style={text}>
        {phone.connected ? "Connected over LAN" : "Disconnected · last valid state"}
        {phone.error ? `\n${phone.error}` : ""}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {(["active", "history", "prs", "hosts"] as const).map((value) => (
          <Button key={value} title={value} onPress={() => setTab(value)} />
        ))}
      </View>
      <Button title="Reconnect / refresh" onPress={phone.refresh} />
      {tab === "hosts" ? (
        <>
          <Text style={text}>
            Trusted LAN HTTPS only. This bearer key has the same API access as remote Workbench.
          </Text>
          {phone.hosts.map((host) => (
            <Button
              key={host.serverId}
              title={host.name}
              onPress={() => phone.selectHost(host.serverId)}
            />
          ))}
          <TextInput
            style={text}
            placeholderTextColor="#a1a1aa"
            placeholder="Connection name"
            value={name}
            onChangeText={setName}
          />
          <TextInput
            style={text}
            placeholderTextColor="#a1a1aa"
            placeholder="https://pc.local:port"
            autoCapitalize="none"
            value={origin}
            onChangeText={setOrigin}
          />
          <TextInput
            style={text}
            placeholderTextColor="#a1a1aa"
            placeholder="Sandbox bearer token"
            secureTextEntry
            autoCapitalize="none"
            value={token}
            onChangeText={setToken}
          />
          <Button
            title="Connect PC"
            onPress={() =>
              void phone
                .addHost(name, origin, token)
                .then(() => {
                  setToken("");
                  setTab("active");
                })
                .catch(failure)
            }
          />
          {phone.host && (
            <>
              <Text style={text}>Phone alerts for this PC</Text>
              <Switch
                value={!phone.muted}
                onValueChange={(enabled) => void phone.setMuted(!enabled).catch(failure)}
              />
              <Text style={text}>
                PC master switch and PC-controlled Away must also permit alerts. Token updates wait
                for LAN access.
              </Text>
              <Button
                title="Register notification permission"
                onPress={() => void phone.notificationSetup().catch(failure)}
              />
              <Button
                title="Remove selected PC"
                onPress={() =>
                  Alert.alert(
                    "Remove PC?",
                    "Mute this phone immediately and remove its LAN registration.",
                    [
                      { text: "Cancel" },
                      { text: "Remove", onPress: () => void phone.removeHost().catch(failure) },
                    ],
                  )
                }
              />
            </>
          )}
        </>
      ) : tab === "prs" ? (
        <>
          {phone.state.github?.error && (
            <Text style={{ color: "#fca5a5" }}>{phone.state.github.error}</Text>
          )}
          {phone.state.github?.prs.map((pr) => (
            <Pressable key={pr.id} onPress={() => void Linking.openURL(pr.url).catch(failure)}>
              <Text style={text}>
                {pr.repository} #{pr.number} · {pr.title}
                {pr.hidden ? " · hidden" : ""}
              </Text>
            </Pressable>
          ))}
        </>
      ) : (
        <>
          {(tab === "active" ? phone.state.active : phone.state.history).map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {tab === "history" && page && (
            <View>
              <Text style={text}>
                {page.label}
                {page.resetReason ? ` · ${page.resetReason}` : ""}
              </Text>
              <Button
                title={page.previous.label}
                disabled={!page.previous.enabled || !phone.connected}
                onPress={() => phone.page(page.previous.cursor)}
              />
              <Button
                title={page.next.label}
                disabled={!page.next.enabled || !phone.connected}
                onPress={() => phone.page(page.next.cursor)}
              />
            </View>
          )}
          {tab === "active" && (
            <>
              <Text style={text}>Create task</Text>
              <TextInput
                style={text}
                placeholderTextColor="#a1a1aa"
                placeholder="Task name"
                value={taskName}
                onChangeText={setTaskName}
              />
              {phone.state.projects?.projects.map((project) => (
                <Button
                  key={project.id}
                  title={`${projectId === project.id ? "✓ " : ""}${project.name}`}
                  onPress={() => setProjectId(project.id)}
                />
              ))}
              <Button
                title="Create"
                disabled={!phone.connected || !taskName || !projectId}
                onPress={() =>
                  void phone.client
                    ?.createTask({ name: taskName, projectId }, randomUUID())
                    .then(() => setTaskName(""))
                    .catch(failure)
                }
              />
            </>
          )}
          {phone.state.operations.map((operation) => (
            <Text key={operation.id} style={text}>
              {operation.taskId}: {operation.kind} · {operation.state} · {operation.stage}
              {operation.error ? `\n${operation.error}` : ""}
            </Text>
          ))}
        </>
      )}
      <Button title="About / licenses" onPress={() => navigation.navigate("SettingsLegal")} />
    </ScrollView>
  );
}
