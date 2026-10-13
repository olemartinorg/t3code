import { ProjectId } from "@t3tools/contracts";
import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { contentBearingNewThreadDraftId, soleOpenConversation } from "../sandboxConversationLaunch";
import { useComposerDraftStore } from "../composerDraftStore";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironments } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroups = useSettingsProjectGroups();
  const externalTarget =
    window.sandboxT3?.version === 1 && window.sandboxT3.getTargetKind?.() === "external-t3";
  const projectIdValue = externalTarget ? (window.sandboxT3?.getProjectId?.() ?? null) : undefined;
  const selectedProjectId =
    projectIdValue == null ? projectIdValue : ProjectId.make(projectIdValue);
  const openIntent = externalTarget ? (window.sandboxT3?.getOpenIntent?.() ?? "open") : "open";
  const contentDraftId = useComposerDraftStore((state) =>
    contentBearingNewThreadDraftId(
      state,
      externalTarget ? primaryEnvironmentId : undefined,
      selectedProjectId,
    ),
  );
  const sole = soleOpenConversation(threads, primaryEnvironmentId, selectedProjectId);
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? externalTarget
          ? (projects.find(
              (project) =>
                project.environmentId === primaryEnvironmentId && project.id === selectedProjectId,
            ) ?? null)
          : (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads, externalTarget, primaryEnvironmentId, selectedProjectId],
  );

  useEffect(() => {
    if (!bootstrapped || primaryEnvironmentId === null || startingRef.current) return;
    if (openIntent === "settings") {
      if (selectedProjectId === null) {
        startingRef.current = true;
        void navigate({
          to: "/settings/general",
          search: { machine: primaryEnvironmentId },
          replace: true,
        });
        return;
      }
      const group = projectGroups.find((group) =>
        group.memberProjects.some(
          (member) =>
            member.environmentId === primaryEnvironmentId && member.id === selectedProjectId,
        ),
      );
      const member = group?.memberProjects.find(
        (member) =>
          member.environmentId === primaryEnvironmentId && member.id === selectedProjectId,
      );
      if (!group || !member) return;
      startingRef.current = true;
      void navigate({
        to: "/settings/projects",
        search: {
          project: group.projectKey,
          machine: primaryEnvironmentId,
          checkout: member.physicalProjectKey,
        },
        replace: true,
      });
      return;
    }
    if (openIntent !== "new-conversation" && contentDraftId !== null) {
      startingRef.current = true;
      void navigate({ to: "/draft/$draftId", params: { draftId: contentDraftId }, replace: true });
      return;
    }
    if (openIntent !== "new-conversation" && sole) {
      startingRef.current = true;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: sole.environmentId, threadId: sole.id },
        replace: true,
      });
      return;
    }
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [
    bootstrapped,
    primaryEnvironmentId,
    sole,
    contentDraftId,
    navigate,
    handleNewThread,
    mostRecentProject,
    startState.retryRequest,
    openIntent,
    projectGroups,
    selectedProjectId,
  ]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  if (externalTarget) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>
              {selectedProjectId === null ? "No project" : "Project unavailable"}
            </EmptyTitle>
            <EmptyDescription>
              {selectedProjectId === null
                ? "Select an existing conversation in Workbench, or choose a project to start a new conversation."
                : "The selected project is no longer available on this environment."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Enable T3 Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle>Connect to a computer running T3 Code</EmptyTitle>
              <EmptyDescription>
                This app connects to T3 Code running on your computer or a server. Start the T3 Code
                desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription>{description}</EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
