const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require("expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");
module.exports = (config) => {
  config = withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) throw new Error("Sandbox Android manifest has no application");
    application.$ ??= {};
    application.$["android:usesCleartextTraffic"] = "false";
    application.$["android:networkSecurityConfig"] = "@xml/sandbox_network_security";
    const permissions = (next.modResults.manifest["uses-permission"] ??= []);
    for (const name of ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"])
      if (!permissions.some((item) => item.$?.["android:name"] === name))
        permissions.push({ $: { "android:name": name } });
    return next;
  });
  config = withMainApplication(config, (next) => {
    if (next.modResults.language !== "kt")
      throw new Error("Sandbox Android requires the native Kotlin Application");
    const source = next.modResults.contents;
    if (!source.includes("SandboxLanTransport.install(this)"))
      next.modResults.contents = source.replace(
        "super.onCreate()",
        "super.onCreate()\n    expo.modules.t3agentnotifications.SandboxLanTransport.install(this)",
      );
    if (!next.modResults.contents.includes("SandboxLanTransport.install(this)"))
      throw new Error("Sandbox LAN initialization could not be installed");
    return next;
  });
  return withDangerousMod(config, [
    "android",
    async (next) => {
      const directory = path.join(next.modRequest.platformProjectRoot, "app/src/main/res/xml");
      await fs.mkdir(directory, { recursive: true });
      // The user may install a LAN CA. Android still checks certificate chains and hostnames.
      await fs.writeFile(
        path.join(directory, "sandbox_network_security.xml"),
        '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/><certificates src="user"/></trust-anchors></base-config></network-security-config>\n',
      );
      return next;
    },
  ]);
};
