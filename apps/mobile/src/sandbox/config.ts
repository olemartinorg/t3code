import type { ExpoConfig } from "expo/config";

/** A separate Android identity. Public mobile config never loads the host's env files. */
export function sandboxAndroidConfig(base: ExpoConfig): ExpoConfig {
  const excluded = new Set([
    "@clerk/expo",
    "expo-widgets",
    "expo-quick-actions",
    "./plugins/withWidgetLogoAsset.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withShareExtensionDisplayName.cjs",
    "./plugins/withIosCocoaPodsUuidCache.cjs",
  ]);
  const plugins = (base.plugins ?? [])
    .filter((plugin) => !excluded.has(typeof plugin === "string" ? plugin : (plugin[0] ?? "")))
    .map((plugin) =>
      Array.isArray(plugin) && plugin[0] === "expo-sharing"
        ? (["expo-sharing", { ...plugin[1], ios: { enabled: false } }] as [
            string,
            Record<string, unknown>,
          ])
        : plugin,
    );
  return {
    ...base,
    name: "Sandbox",
    slug: "sandbox-companion",
    scheme: "sandbox-companion",
    platforms: ["android"],
    owner: undefined,
    ios: undefined,
    updates: { enabled: false, checkAutomatically: "NEVER" },
    android: { ...base.android, package: "org.olemartin.sandbox.companion" },
    plugins: [...plugins, "./plugins/withSandboxAndroid.cjs"],
    extra: {
      appVariant: "sandbox",
      sandboxCompanion: true,
      relay: { url: null },
      clerk: { publishableKey: null, jwtTemplate: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    },
  };
}
