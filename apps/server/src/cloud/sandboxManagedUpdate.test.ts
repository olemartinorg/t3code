import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { make, resolveServerSelfUpdateCapability } from "./selfUpdate.js";
test("the managed vendor runtime advertises no self-update in any launcher mode", () => {
  for (const desktopManaged of [false, true]) for (const launcherManaged of [false, true])
    expect(resolveServerSelfUpdateCapability({ desktopManaged, launcherManaged })).toBeNull();
});
test("server update and desktop commit fail before network or filesystem work", async () => {
  const service = await Effect.runPromise(make());
  for (const effect of [service.update({ targetVersion: "0.0.46" }), service.commitDesktopUpdate("request")]) {
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("managed by Sandbox");
  }
});
