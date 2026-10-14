const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const extraThemes = require("./generated-uniwind-theme-names.json");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const generatedLicenseModuleRoot = path.join(__dirname, ".generated", "third-party-licenses");
const licenseGeneratorSource = path.join(
  workspaceRoot,
  "scripts",
  "lib",
  "third-party-licenses.ts",
);
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const generatedDeviceStreamRoot = path.join(__dirname, ".generated", "device-stream");
const generatedPreviewStreamRoot = path.join(__dirname, ".generated", "preview-stream");
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

const sandboxClientRoot =
  process.env.APP_VARIANT === "sandbox" ? process.env.SANDBOX_CLIENT_ROOT : undefined;
if (process.env.APP_VARIANT === "sandbox" && !sandboxClientRoot)
  throw new Error("Sandbox Android requires the matching Sandbox SDK input");
config.watchFolders = [
  ...new Set([
    ...(config.watchFolders ?? []),
    workspaceRoot,
    ...(sandboxClientRoot
      ? [sandboxClientRoot, fs.realpathSync(path.join(sandboxClientRoot, "node_modules"))]
      : []),
  ]),
];
config.resolver = {
  ...config.resolver,
  ...(sandboxClientRoot
    ? {
        resolveRequest: (context, name, platform) => {
          if (name === "sandbox/client" || name === "sandbox/contracts") {
            const manifest = JSON.parse(
              fs.readFileSync(path.join(sandboxClientRoot, "package.json"), "utf8"),
            );
            const entry =
              manifest.exports?.[name === "sandbox/client" ? "./client" : "./contracts"];
            const target = typeof entry === "string" ? entry : entry?.default;
            if (!target || !target.startsWith("./dist/"))
              throw new Error("Sandbox SDK public export is unavailable");
            return { type: "sourceFile", filePath: path.join(sandboxClientRoot, target) };
          }
          return context.resolveRequest(context, name, platform);
        },
      }
    : {}),
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    ...(sandboxClientRoot ? { sandbox: sandboxClientRoot } : {}),
    "@t3tools/mobile-third-party-licenses": generatedLicenseModuleRoot,
    "@t3tools/mobile-device-stream": generatedDeviceStreamRoot,
    "@t3tools/mobile-preview-stream": generatedPreviewStreamRoot,
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

async function writeFileIfChanged(filePath, contents) {
  try {
    if ((await fs.promises.readFile(filePath, "utf8")) === contents) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.promises.writeFile(filePath, contents, "utf8");
}

async function generateMobileThirdPartyLicenses() {
  await fs.promises.mkdir(generatedLicenseModuleRoot, { recursive: true });
  const generatorVersion = (await fs.promises.stat(licenseGeneratorSource)).mtimeMs;
  const { generateThirdPartyLicenseManifest } = await import(
    `${pathToFileURL(licenseGeneratorSource).href}?version=${String(generatorVersion)}`
  );
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: path.join(workspaceRoot, "third-party-licenses.config.json"),
    packageManifests: [
      { bundle: "mobile", path: path.join(__dirname, "package.json") },
      ...(sandboxClientRoot
        ? [{ bundle: "mobile", path: path.join(sandboxClientRoot, "package.json") }]
        : []),
    ],
    allowMissingGeneratedNotices:
      process.env.NODE_ENV !== "production" &&
      process.env.EAS_BUILD !== "true" &&
      process.env.T3CODE_LICENSES_STRICT !== "1",
  });

  await Promise.all([
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "index.js"),
      `module.exports = ${JSON.stringify(manifest)};\n`,
    ),
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "package.json"),
      '{"main":"index.js"}\n',
    ),
  ]);
}

async function prepareStreamScripts() {
  const { generateDeviceStreamScript, generatePreviewStreamScript } = await import(
    pathToFileURL(path.join(__dirname, "scripts", "generate-device-stream.mts")).href
  );
  const generateAll = () =>
    Promise.all([generateDeviceStreamScript(), generatePreviewStreamScript()]);
  await generateAll();
  if (process.env.NODE_ENV !== "production") {
    let rebuild = Promise.resolve();
    for (const [directory, files, generate] of [
      [
        "apps/mobile/src/features/devices",
        ["device-stream.browser.ts"],
        generateDeviceStreamScript,
      ],
      [
        "apps/mobile/src/features/browser",
        ["preview-stream.browser.ts"],
        generatePreviewStreamScript,
      ],
      // The preview transport also imports `hubAccess.ts`.
      ["packages/client-runtime/src/device", ["stream.ts", "hubAccess.ts"], generateAll],
      [
        "packages/client-runtime/src/preview",
        ["serverBrowserStream.ts"],
        generatePreviewStreamScript,
      ],
    ]) {
      // The generated modules participate in Metro's normal Fast Refresh.
      fs.watch(path.join(workspaceRoot, directory), { persistent: false }, (_event, filename) => {
        if (filename && !files.includes(String(filename))) return;
        rebuild = rebuild
          .then(generate)
          .then(() => undefined)
          .catch((error) => {
            console.error("Could not rebuild a WebView stream script:", error);
          });
      });
    }
  }
}

module.exports = Promise.all([generateMobileThirdPartyLicenses(), prepareStreamScripts()]).then(
  () =>
    withUniwindConfig(config, {
      cssEntryFile: "./global.css",
      extraThemes,
      polyfills: { rem: 14 },
    }),
);
