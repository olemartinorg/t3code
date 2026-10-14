import { expect, test } from "@effect/vitest";
import { sandboxAndroidConfig } from "./config.ts";
test("Sandbox APK has independent identity, no cloud/OTA configuration and normal Android TLS", () => {
  const config = sandboxAndroidConfig({
    name: "T3 Code",
    slug: "t3",
    scheme: "t3code",
    owner: "upstream",
    android: { package: "com.t3tools.t3code" },
    updates: { enabled: true, url: "https://u.expo.dev/upstream" },
    extra: { eas: { projectId: "upstream" }, clerk: { publishableKey: "upstream" } },
    plugins: [
      "expo-asset",
      ["@clerk/expo", {}],
      ["expo-widgets", {}],
      "./plugins/withAndroidCleartextTraffic.cjs",
    ],
  });
  expect(config).toMatchObject({
    name: "Sandbox",
    slug: "sandbox-companion",
    scheme: "sandbox-companion",
    platforms: ["android"],
    android: { package: "org.olemartin.sandbox.companion" },
    updates: { enabled: false, checkAutomatically: "NEVER" },
    extra: {
      androidPushConfigured: false,
      sandboxCompanion: true,
      relay: { url: null },
      clerk: { publishableKey: null },
    },
  });
  expect(config.updates?.url).toBeUndefined();
  expect(config.extra?.eas).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.plugins).toEqual(["expo-asset", "./plugins/withSandboxAndroid.cjs"]);
});

test("companion keeps Android 36 target while retaining stock compile tools and vendor rules", () => {
  const config = sandboxAndroidConfig({
    name: "T3",
    slug: "t3",
    plugins: [
      [
        "expo-build-properties",
        { android: { compileSdkVersion: 37, extraProguardRules: "owned-vendor-rule" } },
      ],
    ],
  });
  expect(config.plugins?.[0]).toEqual([
    "expo-build-properties",
    {
      android: {
        compileSdkVersion: 37,
        targetSdkVersion: 36,
        extraProguardRules: "owned-vendor-rule",
      },
    },
  ]);
});
