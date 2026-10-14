import { EnvironmentId } from "@t3tools/contracts";
import {
  EnvironmentRegistry,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  createRuntimeCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { SandboxApiClient } from "sandbox/client";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { currentNativeView, setNativeView, nativeSandbox, type NativeView } from "./transport";

export type PhoneHost = {
  serverId: string;
  name: string;
  origin: string;
  token: string;
  notifications: boolean;
};
const changeNativeConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "sandbox:view:connection",
  execute: (input: { environmentId: string; origin: string; label: string; enabled: boolean }) =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry,
        environmentId = EnvironmentId.make(input.environmentId);
      if (input.enabled) {
        const socket = new URL(input.origin);
        socket.protocol = "wss:";
        yield* registry.registerPlatform(
          new PrimaryConnectionRegistration({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: input.label,
              httpBaseUrl: input.origin,
              wsBaseUrl: socket.toString(),
            }),
          }),
        );
      }
      yield* registry.setEnabled(environmentId, input.enabled);
    }),
});
async function nativeConnection(view: NativeView, label: string, enabled: boolean) {
  const result = await runAtomCommand(
    appAtomRegistry,
    changeNativeConnection,
    { environmentId: view.session.environmentId, origin: view.origin, label, enabled },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}

type OwnedView = { view: NativeView; host: PhoneHost; client: SandboxApiClient; hold: WebSocket };
let owned: OwnedView | null = null,
  generation = 0;
let retirement = Promise.resolve();
function retire(current: OwnedView | null): Promise<void> {
  retirement = retirement.then(() => retireOwned(current));
  return retirement;
}
async function retireOwned(current: OwnedView | null) {
  if (!current) return;
  current.hold.close();
  await nativeConnection(current.view, current.host.name, false).catch(() => {});
  await current.client.releaseT3View(current.view.session).catch(() => {});
  nativeSandbox().setSandboxThreadOnScreen(null, null);
}
export async function closePhoneView() {
  generation++;
  const previous = owned;
  owned = null;
  setNativeView(null);
  await retire(previous);
}
export async function openPhoneView(
  host: PhoneHost,
  request: Parameters<SandboxApiClient["openT3Target"]>[0],
): Promise<NativeView> {
  const currentGeneration = ++generation;
  const previous = owned;
  owned = null;
  setNativeView(null);
  await retire(previous);
  const client = new SandboxApiClient(host.origin, host.token),
    session = await client.openT3Target(request);
  const view: NativeView = { origin: client.origin.origin, generation: currentGeneration, session };
  if (generation !== currentGeneration) {
    await client.releaseT3View(session).catch(() => {});
    throw new Error("Conversation navigation changed");
  }
  const Constructor = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const hold = new Constructor(client.t3ViewLeaseUrl(session), [], {
    headers: { authorization: `Bearer ${host.token}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Conversation lease did not open"));
        hold.close();
      }, 15_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      hold.addEventListener("open", () => finish(), { once: true });
      hold.addEventListener("error", () => finish(new Error("Conversation lease is unavailable")), {
        once: true,
      });
      hold.addEventListener("close", () => finish(new Error("Conversation lease closed")), {
        once: true,
      });
    });
    if (generation !== currentGeneration) throw new Error("Conversation navigation changed");
    owned = { view, host, client, hold };
    setNativeView(view);
    hold.addEventListener("close", () => {
      if (owned?.hold === hold) void closePhoneView();
    });
    await nativeConnection(view, host.name, true);
    if (generation !== currentGeneration || currentNativeView() !== view)
      throw new Error("Conversation navigation changed");
    if (request.conversationId)
      nativeSandbox().setSandboxThreadOnScreen(
        host.serverId,
        JSON.stringify(
          request.kind === "sandbox"
            ? {
                kind: request.kind,
                taskId: request.taskId,
                stableId: request.stableId,
                conversationId: request.conversationId,
              }
            : {
                kind: request.kind,
                environmentId: request.environmentId,
                projectId: request.projectId,
                conversationId: request.conversationId,
              },
        ),
      );
    return view;
  } catch (error) {
    hold.close();
    if (owned?.hold === hold) {
      owned = null;
      setNativeView(null);
    }
    await nativeConnection(view, host.name, false).catch(() => {});
    await client.releaseT3View(session).catch(() => {});
    throw error;
  }
}
