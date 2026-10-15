import { EnvironmentId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it } from "vite-plus/test";
import { makeThreadProjectionFixture } from "./test-fixtures";
import * as DateTime from "effect/DateTime";
import { composerDraftPresenceEntries } from "./composerDraftPresence";
import type { DraftThreadState } from "./composerDraftStore";

const environmentId = EnvironmentId.make("desktop-environment");
const v2ThreadShell = makeThreadProjectionFixture().thread;
const v2Project = { id: v2ThreadShell.projectId };
const key = scopedThreadKey({ environmentId, threadId: v2ThreadShell.id });
const content = {
  prompt: "",
  images: [],
  files: [],
  persistedAttachments: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
};
const shell = { projects: [v2Project], threads: [v2ThreadShell] };
const local: DraftThreadState = {
  environmentId,
  projectId: v2Project.id,
  logicalProjectKey: "project",
  threadId: v2ThreadShell.id,
  createdAt: "2026-01-01",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
};

it("uses the native content predicate and selected destination without fabricating threads", () => {
  const select = (draft: typeof content | ({ prompt: string } & Omit<typeof content, "prompt">)) =>
    composerDraftPresenceEntries(
      {
        draftsByThreadKey: { [key]: draft },
        draftThreadsByThreadKey: {},
        backgroundSubmissionThreadKeys: {},
      },
      environmentId,
      shell,
    );
  expect(select(content)).toEqual([]);
  expect(select({ ...content, prompt: "Unsent" })).toEqual([
    { projectId: v2Project.id, threadId: v2ThreadShell.id },
  ]);
  for (const field of [
    "files",
    "persistedAttachments",
    "terminalContexts",
    "previewAnnotations",
    "reviewComments",
    "threadContexts",
  ] as const) {
    expect(
      composerDraftPresenceEntries(
        {
          draftsByThreadKey: { [key]: { ...content, [field]: [{}] } },
          draftThreadsByThreadKey: {},
          backgroundSubmissionThreadKeys: {},
        },
        environmentId,
        shell,
      ),
    ).toHaveLength(1);
  }
  const state = {
    draftsByThreadKey: { local: { ...content, prompt: "New conversation" } },
    draftThreadsByThreadKey: { local },
    backgroundSubmissionThreadKeys: {},
  };
  expect(composerDraftPresenceEntries(state, environmentId, shell)).toEqual([
    { projectId: v2Project.id, draftId: "local" },
  ]);
  expect(
    composerDraftPresenceEntries({ ...state, draftThreadsByThreadKey: {} }, environmentId, shell),
  ).toEqual([]);
  expect(composerDraftPresenceEntries(state, EnvironmentId.make("other"), shell)).toEqual([]);
  expect(
    composerDraftPresenceEntries(
      {
        ...state,
        draftThreadsByThreadKey: {
          local: { ...local, promotedTo: { environmentId, threadId: v2ThreadShell.id } },
        },
      },
      environmentId,
      shell,
    ),
  ).toEqual([]);
});

it("omits queued, archived, settled and subagent destinations", () => {
  const state = {
    draftsByThreadKey: { [key]: { ...content, prompt: "Unsent" } },
    draftThreadsByThreadKey: {},
    backgroundSubmissionThreadKeys: {},
  };
  expect(
    composerDraftPresenceEntries(
      { ...state, backgroundSubmissionThreadKeys: { [key]: true } },
      environmentId,
      shell,
    ),
  ).toEqual([]);
  for (const thread of [
    { ...v2ThreadShell, archivedAt: DateTime.makeUnsafe("2026-01-01") },
    { ...v2ThreadShell, settledOverride: "settled" as const },
    {
      ...v2ThreadShell,
      lineage: { ...v2ThreadShell.lineage, relationshipToParent: "subagent" as const },
    },
  ])
    expect(
      composerDraftPresenceEntries(state, environmentId, { ...shell, threads: [thread] }),
    ).toEqual([]);
});
