import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { DraftPresence } from "./DraftPresence.ts";

export const emptyDraftPresenceLayer = Layer.effect(
  DraftPresence,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<never>();
    return DraftPresence.of({
      snapshot: Effect.succeed({
        environmentId: EnvironmentId.make("draft-test"),
        revision: 0,
        projects: [],
      }),
      subscribeChanges: PubSub.subscribe(changes),
      openSource: () => Effect.succeed({ writerEpoch: 1 }),
      replace: () => Effect.void,
    });
  }),
);
