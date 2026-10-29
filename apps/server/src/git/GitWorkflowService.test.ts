import * as Option from "effect/Option";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect.each([false, true])(
    "guarded advancement overrides squash, holds admission and preserves dirty checkouts, prepared merge=%s",
    (preparedMerge) => {
      const admission = { active: false, held: false, visits: 0 };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-advance-branch-" });
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const git = (args: string[]) =>
          driver
            .execute({ operation: "test.advanceBranch", cwd, args })
            .pipe(Effect.map((result) => result.stdout.trim()));
        yield* git(["init", "-qb", "main"]);
        yield* git([
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--allow-empty",
          "-qm",
          "base",
        ]);
        let expectedHead = yield* git(["rev-parse", "HEAD"]);
        yield* git(["switch", "-qc", "remote"]);
        yield* fs.writeFileString(`${cwd}/new`, "remote contents\n");
        yield* git(["add", "new"]);
        yield* git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remote"]);
        const remoteHead = yield* git(["rev-parse", "HEAD"]);
        let targetHead = remoteHead;
        yield* git(["switch", "-q", "main"]);
        if (preparedMerge) {
          yield* fs.writeFileString(`${cwd}/local`, "local contents\n");
          yield* git(["add", "local"]);
          yield* git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "local"]);
          expectedHead = yield* git(["rev-parse", "HEAD"]);
          const tree = yield* git(["merge-tree", "--write-tree", expectedHead, remoteHead]);
          targetHead = yield* git([
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit-tree",
            tree,
            "-p",
            expectedHead,
            "-p",
            remoteHead,
            "-m",
            "prepared merge",
          ]);
        }
        yield* git(["config", "branch.main.mergeOptions", "--squash --no-commit"]);
        const input = { cwd, refName: "main", expectedHead, targetHead };
        admission.active = true;
        const busy = yield* workflow.advanceBranch(input).pipe(Effect.flip);
        expect(busy).toMatchObject({ _tag: "VcsAdvanceBranchGuardedError", reason: "active-work" });
        expect(yield* git(["rev-parse", "HEAD"])).toBe(expectedHead);
        admission.active = false;
        yield* fs.writeFileString(`${cwd}/untracked`, "keep\n");
        const index = yield* fs.readFile(`${cwd}/.git/index`);
        const dirty = yield* workflow.advanceBranch(input).pipe(Effect.flip);
        expect(dirty).toMatchObject({
          _tag: "VcsAdvanceBranchGuardedError",
          reason: "checkout-changed",
        });
        expect(yield* fs.readFile(`${cwd}/.git/index`)).toEqual(index);
        expect(yield* git(["rev-parse", "HEAD"])).toBe(expectedHead);
        yield* fs.remove(`${cwd}/untracked`);
        const stale = yield* workflow
          .advanceBranch({ ...input, expectedHead: "0".repeat(40) })
          .pipe(Effect.flip);
        expect(stale).toMatchObject({
          _tag: "VcsAdvanceBranchGuardedError",
          reason: "checkout-changed",
        });
        expect(yield* git(["rev-parse", "HEAD"])).toBe(expectedHead);
        yield* workflow.advanceBranch(input);
        expect(yield* git(["rev-parse", "HEAD"])).toBe(targetHead);
        expect(yield* git(["rev-parse", "main"])).toBe(targetHead);
        expect(yield* git(["write-tree"])).toBe(yield* git(["rev-parse", `${targetHead}^{tree}`]));
        expect(yield* git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
        expect(yield* fs.readFileString(`${cwd}/new`)).toBe("remote contents\n");
        if (preparedMerge) {
          expect(yield* git(["show", "-s", "--format=%P", targetHead])).toBe(
            `${expectedHead} ${remoteHead}`,
          );
          expect(yield* fs.readFileString(`${cwd}/local`)).toBe("local contents\n");
        }
        expect(yield* fs.exists(`${cwd}/.git/MERGE_HEAD`)).toBe(false);
        expect(admission.visits).toBe(4);
        expect(admission.held).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(
              Layer.mock(EventSink.EventSinkV2)({
                withCheckoutAdmission: (cwd, effect) =>
                  Effect.gen(function* () {
                    admission.visits++;
                    if (admission.active)
                      return yield* new EventSink.CheckoutAdmissionError({
                        cwd,
                        reason: "active-work",
                      });
                    admission.held = true;
                    return yield* effect.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          admission.held = false;
                        }),
                      ),
                    );
                  }),
              }),
            ),
            Layer.provide(
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                resolve: ({ cwd }) =>
                  Effect.succeed({
                    kind: "git",
                    repository: { rootPath: cwd },
                  } as VcsDriverRegistry.VcsDriverHandle),
              }),
            ),
            Layer.provide(Layer.mock(GitManager.GitManager)({})),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provideMerge(VcsProcess.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-advance-branch-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    },
  );

  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const layerTest = GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
