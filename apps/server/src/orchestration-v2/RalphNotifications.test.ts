import { assert, it } from "@effect/vitest";
import { selectRalphNotification } from "./RalphNotifications.ts";
import { EventId, RunId } from "@t3tools/contracts";
const binding = { ownerId: "owner", loopId: "loop", revision: 1 };
const a = {
  binding,
  eventId: EventId.make("final-A"),
  runId: RunId.make("A"),
  admissionCommandId: null,
  occurredAt: 100,
  workDurationMs: 1_000,
  finalResponse: "ralph-complete" as const,
  recovery: false,
  disposition: "released" as const,
};
const b = {
  ...a,
  eventId: EventId.make("intermediate-B"),
  runId: RunId.make("B"),
  disposition: "consumed" as const,
};
it("same binding selects original released A; ordinary C has no Ralph notification", () => {
  assert.deepStrictEqual(selectRalphNotification(b.runId, b, a), {
    kind: "released",
    eventId: a.eventId,
    runId: a.runId,
    occurredAt: a.occurredAt,
    recovery: false,
  });
  assert.strictEqual(selectRalphNotification(RunId.make("C"), b, a), null);
});
it.each([{ ownerId: "other" }, { loopId: "new" }, { revision: 2 }])(
  "different binding %s stays quiet",
  (changed) => {
    assert.deepStrictEqual(
      selectRalphNotification(b.runId, { ...b, binding: { ...binding, ...changed } }, a),
      { kind: "quiet" },
    );
  },
);
