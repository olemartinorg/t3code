import { beforeEach, expect, test, vi } from "vite-plus/test";
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(store.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve();
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("expo", () => ({ requireNativeModule: () => ({}) }));
import { installationId, readPhoneHosts, savePhoneHosts } from "./profiles";
const host = {
  serverId: "22222222-2222-4222-8222-222222222222",
  name: "Owned PC",
  origin: "https://pc.local:19480",
  token: "fixture-only-key",
  notifications: false,
};
beforeEach(() => store.clear());
test("phone installation and private host identity survive restart without desktop draft hydration", async () => {
  const id = await installationId();
  expect(await installationId()).toBe(id);
  await savePhoneHosts([host]);
  expect(await readPhoneHosts()).toEqual([host]);
  expect([...store.keys()].sort()).toEqual(["sandbox.hosts.v1", "sandbox.installation.v1"]);
});
test("damaged host records remain untouched and fail explicitly instead of redirecting or replacing identity", async () => {
  const original = JSON.stringify([{ ...host, origin: "https://key@pc.local" }]);
  store.set("sandbox.hosts.v1", original);
  await expect(readPhoneHosts()).rejects.toThrow();
  expect(store.get("sandbox.hosts.v1")).toBe(original);
});
test("invalid saved installation is preserved instead of producing a replacement push identity", async () => {
  store.set("sandbox.installation.v1", "invalid-fixture-id");
  await expect(installationId()).rejects.toThrow("invalid");
  expect(store.get("sandbox.installation.v1")).toBe("invalid-fixture-id");
});
