import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { trustedOrigin } from "./transport";
import type { PhoneHost } from "./view-controller";
const HOSTS = "sandbox.hosts.v1",
  INSTALLATION = "sandbox.installation.v1";
export async function installationId() {
  let id = await SecureStore.getItemAsync(INSTALLATION);
  if (!id) {
    id = randomUUID();
    await SecureStore.setItemAsync(INSTALLATION, id);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Saved phone installation identity is invalid");
  return id;
}
export async function readPhoneHosts(): Promise<PhoneHost[]> {
  const raw = await SecureStore.getItemAsync(HOSTS);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.some(
      (host) =>
        !host ||
        typeof host !== "object" ||
        typeof host.serverId !== "string" ||
        typeof host.name !== "string" ||
        typeof host.origin !== "string" ||
        typeof host.token !== "string" ||
        typeof host.notifications !== "boolean",
    )
  )
    throw new Error("Saved Sandbox hosts cannot be loaded");
  for (const host of value) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(host.serverId) ||
      !host.name.trim() ||
      host.name.length > 80 ||
      !host.token ||
      host.token.length > 8192 ||
      /[\r\n]/.test(host.token) ||
      trustedOrigin(host.origin) !== host.origin
    )
      throw new Error("Saved Sandbox host is invalid");
  }
  if (new Set(value.map((host) => host.serverId)).size !== value.length)
    throw new Error("Saved Sandbox host identities are duplicated");
  return value as PhoneHost[];
}
export async function savePhoneHosts(hosts: PhoneHost[]) {
  await SecureStore.setItemAsync(HOSTS, JSON.stringify(hosts));
}
