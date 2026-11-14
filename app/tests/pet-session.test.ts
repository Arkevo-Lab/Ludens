import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractProjectFromUrl,
  PetSessionCoordinator,
  selectAutoFollowTarget,
  type PetTarget,
} from "../desktop/pet-session";
import type { LudensActivitySnapshot, LudensPetSnapshot } from "../desktop/ludens-source";
import type { Project } from "../lib/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeProject(
  id: string,
  options?: {
    online?: boolean;
    mode?: string;
    consolidating?: boolean;
    pendingOutbound?: number;
    available?: boolean;
  },
): Project {
  const online = options?.online ?? true;
  return {
    id,
    name: id,
    available: options?.available ?? true,
    workspace: `/workspaces/${id}`,
    runs: [],
    core: {
      online,
      mode: options?.mode ?? "manual",
      consolidating: options?.consolidating ?? false,
      pendingOutbound: options?.pendingOutbound ?? 0,
      launchedBy: "app",
    },
  };
}

function makeSnapshot(workspace: string): LudensActivitySnapshot {
  const current: LudensPetSnapshot = {
    workspace,
    runId: `run-${workspace}`,
    epoch: "epoch-1",
    phase: "following",
    intent: null,
    observationUrl: null,
    updatedAt: null,
    error: null,
    dashboardUrl: "http://localhost:3015",
  };
  return {
    identity: `${workspace}:run:epoch`,
    activity: "running",
    blocks: [],
    mode: "snapshot",
    revision: 1,
    hasMore: false,
    current,
  };
}

test("extractProjectFromUrl parses ?project= only for matching origin", () => {
  assert.equal(
    extractProjectFromUrl("http://127.0.0.1:3015/?view=live&project=ws-alpha", "http://127.0.0.1:3015"),
    "ws-alpha",
  );
  assert.equal(
    extractProjectFromUrl("http://127.0.0.1:3015/?view=live", "http://127.0.0.1:3015"),
    null,
  );
  assert.equal(
    extractProjectFromUrl("http://127.0.0.1:9999/?project=ws-alpha", "http://127.0.0.1:3015"),
    null,
  );
  assert.equal(extractProjectFromUrl("not-a-url", "http://127.0.0.1:3015"), null);
});

test("selectAutoFollowTarget enforces priority: SOS > focused Core > background Auto > fallback online", () => {
  const standbyA = makeProject("ws-a", { mode: "manual", pendingOutbound: 0 });
  const autoB = makeProject("ws-b", { mode: "auto", pendingOutbound: 0 });
  const sosC = makeProject("ws-c", { mode: "manual", pendingOutbound: 2 });
  const sosD = makeProject("ws-d", { mode: "auto", pendingOutbound: 1 });
  const offlineSos = makeProject("ws-offline", { online: false, pendingOutbound: 5 });

  // 1. SOS wins over focused and background Auto (and offline Cores are ignored)
  assert.equal(
    selectAutoFollowTarget([offlineSos, standbyA, autoB, sosC], "ws-a")?.id,
    "ws-c",
  );

  // When multiple Cores have pendingOutbound > 0, focused project breaks the tie
  assert.equal(
    selectAutoFollowTarget([standbyA, sosC, sosD], "ws-d")?.id,
    "ws-d",
  );

  // 2. Without SOS, focused online Core wins over background Auto
  assert.equal(
    selectAutoFollowTarget([standbyA, autoB], "ws-a")?.id,
    "ws-a",
  );

  // 3. When focused project is offline or null, falls back to background Auto Core
  const offlineFocused = makeProject("ws-focused-offline", { online: false });
  assert.equal(
    selectAutoFollowTarget([offlineFocused, standbyA, autoB], "ws-focused-offline")?.id,
    "ws-b",
  );
  assert.equal(
    selectAutoFollowTarget([standbyA, autoB], null)?.id,
    "ws-b",
  );

  // 4. Only manual standby Core online -> still selects that online Core
  assert.equal(selectAutoFollowTarget([standbyA], null)?.id, "ws-a");

  // 5. No online Cores -> null
  assert.equal(selectAutoFollowTarget([offlineSos, offlineFocused], "ws-offline"), null);
});

test("PetSessionCoordinator supports !auto priority switching, setFocusedProject, graceful idle, fixed target, and explicit stop", async () => {
  let petPayload: {
    target: PetTarget | null;
    targetConfigured: boolean;
    autoFollowing?: boolean;
  } = {
    target: null,
    targetConfigured: false,
    autoFollowing: true,
  };
  let catalogProjects: Project[] = [];
  const createdWorkspaces: string[] = [];
  const stoppedWorkspaces: string[] = [];
  const snapshots: LudensPetSnapshot[] = [];
  let targetChangeCount = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/catalog")) {
      return Response.json(catalogProjects);
    }
    if (init?.method === "POST") {
      return Response.json({ consumer: JSON.parse(String(init.body)) });
    }
    return Response.json(petPayload);
  }) as typeof fetch;

  const session = new PetSessionCoordinator({
    dashboardUrl: "http://127.0.0.1:3015",
    onSnapshot: value => snapshots.push(value),
    onTargetChanged: () => {
      targetChangeCount += 1;
    },
    createSource: (workspace, onSnapshot) => {
      createdWorkspaces.push(workspace);
      const snap = makeSnapshot(workspace);
      queueMicrotask(() => onSnapshot(snap.current));
      return {
        identity: () => workspace,
        read: async () => snap,
        stop: () => {
          stoppedWorkspaces.push(workspace);
        },
      };
    },
  });

  try {
    // 1. !auto with 0 online Cores -> graceful idle without creating sources or erroring
    await session.pollTarget();
    assert.equal(createdWorkspaces.length, 0);
    assert.equal(snapshots.at(-1)?.phase, "等待活跃 Core");
    assert.equal(snapshots.at(-1)?.error, null);
    const changesAtEmpty = targetChangeCount;

    // Repeated empty poll does not churn or throw
    await session.pollTarget();
    assert.equal(targetChangeCount, changesAtEmpty);

    // 2. Background Auto Core comes online while focused project is offline -> follows Auto Core
    catalogProjects = [
      makeProject("ws-focus", { online: false }),
      makeProject("ws-auto", { online: true, mode: "auto" }),
    ];
    session.setFocusedProject("ws-focus");
    await session.pollTarget();
    assert.equal(createdWorkspaces.at(-1), "/workspaces/ws-auto");

    // 3. Another Core becomes focused & online -> setFocusedProject switches immediately
    catalogProjects = [
      makeProject("ws-focus", { online: true, mode: "manual" }),
      makeProject("ws-auto", { online: true, mode: "auto" }),
    ];
    await session.pollTarget();
    assert.equal(createdWorkspaces.at(-1), "/workspaces/ws-focus");
    assert.ok(stoppedWorkspaces.includes("/workspaces/ws-auto"));

    // 4. SOS Core raises pendingOutbound > 0 -> overrides focused Core
    catalogProjects = [
      makeProject("ws-focus", { online: true, mode: "manual", pendingOutbound: 0 }),
      makeProject("ws-auto", { online: true, mode: "auto", pendingOutbound: 1 }),
    ];
    await session.pollTarget();
    assert.equal(createdWorkspaces.at(-1), "/workspaces/ws-auto");

    // 5. Fixed target mode ignores auto-follow priority and sticks to configured workspace
    petPayload = {
      target: {
        project: "ws-fixed",
        workspace: "/workspaces/ws-fixed",
        revision: "rev-fixed",
        updatedAt: "2026-11-13T12:00:00Z",
      },
      targetConfigured: true,
      autoFollowing: false,
    };
    await session.pollTarget();
    assert.equal(createdWorkspaces.at(-1), "/workspaces/ws-fixed");

    // 6. Explicit stop mode (`targetConfigured: true, target: null`) stays idle even with online SOS Cores
    petPayload = {
      target: null,
      targetConfigured: true,
      autoFollowing: false,
    };
    await session.pollTarget();
    assert.ok(stoppedWorkspaces.includes("/workspaces/ws-fixed"));
    assert.equal((await session.read()).current.workspace, null);
    assert.equal(snapshots.at(-1)?.phase, "请选择要跟随的工作区");
  } finally {
    session.stop();
  }
});
