import { createContext } from "react";
import {
  DEFAULT_MAX_LIVE_EPICS,
  OpenEpicSessionRegistry,
} from "@/stores/epics/open-epic/session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { getLiveHostStreamClient } from "@/lib/host/stream-runtime-context";
import { releaseDesktopEpicOwnershipForEpic } from "@/lib/windows/desktop-epic-ownership";

export const EpicSessionContext = createContext<OpenEpicStoreHandle | null>(
  null,
);

export const handleHostIds = new WeakMap<OpenEpicStoreHandle, string | null>();

/**
 * The `WsStreamClient` each live session last subscribed through. A host
 * restart replaces the transport under a STABLE `hostId` and `close()`s the
 * prior client, but the session keyed on that `hostId` is reused and its in
 * flight stream dies with the old client. The provider compares the current
 * transport against this map to re-open the stream on the new client; the
 * factory itself always resolves the live client (see
 * `createDefaultEpicStreamClient`), so this only decides WHEN to re-subscribe,
 * never WHICH client to subscribe on. The value is `null` for a session that
 * subscribed while no transport was live (an inert pending stream), so the
 * provider re-opens it once a live client appears; `undefined` (absent) means a
 * freshly created handle that already subscribed on the current client.
 */
export const handleStreamClients = new WeakMap<
  OpenEpicStoreHandle,
  WsStreamClient<HostStreamRpcRegistry> | null
>();

/**
 * Registry is module-scoped so background Epic tabs survive route transitions
 * - a tab that is navigated away from but kept open in the tab strip stays
 * live (within the MRU cap) so re-entering the route is instant.
 */
export const registry = new OpenEpicSessionRegistry({
  maxLive: DEFAULT_MAX_LIVE_EPICS,
});
registry.setReleaseListener((epicId) => {
  void releaseDesktopEpicOwnershipForEpic(epicId);
});

/**
 * Test / production seam. Defaults to real `EpicStreamClient`; tests swap
 * via `__setEpicStreamClientFactoryForTests(...)` so the provider can be
 * mounted in jsdom without a live host.
 */
let streamClientFactoryOverride: EpicStreamClientFactory | null = null;

export function __setEpicStreamClientFactoryForTests(
  factory: EpicStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getEpicStreamClientFactoryOverride(): EpicStreamClientFactory | null {
  return streamClientFactoryOverride;
}

/**
 * Inert stream returned when no live transport is available at subscribe-time
 * (the host is transiently not-ready, e.g. mid-restart). Degrading to a no-op
 * pending stream instead of throwing keeps the renderer alive: the session
 * stays in its "connecting" state, queues local edits as usual, and the
 * provider re-opens it on the real client via `requestFreshSnapshot` once a
 * live transport is mirrored in (see EpicSessionProvider's reconcile). It is
 * stateless, so one shared instance is safe.
 */
const PENDING_EPIC_STREAM_CLIENT = {
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
};

/**
 * Default `EpicStreamClientFactory` the open-epic store is created with.
 *
 * STABLE module-level identity - deliberately NOT a per-provider closure. The
 * store is cached in the MRU registry and outlives any one `EpicSessionProvider`
 * instance (a host restart unmounts the routed page via the not-ready host gate,
 * then remounts it onto the SAME cached store). Resolving the transport through
 * `getLiveHostStreamClient()` at subscribe-time means the store always reaches
 * the CURRENT live client, never one captured by a now-unmounted provider that
 * the restart has since closed - which is what threw "Cannot subscribe with a
 * closed WsStreamClient" and tore the renderer down. When no client is live yet
 * it degrades to an inert pending stream rather than throwing.
 */
export const createDefaultEpicStreamClient: EpicStreamClientFactory = (
  epicId,
  callbacks,
) => {
  const override = streamClientFactoryOverride;
  if (override !== null) {
    return override(epicId, callbacks);
  }
  const client = getLiveHostStreamClient();
  if (client === null) {
    return PENDING_EPIC_STREAM_CLIENT;
  }
  return new EpicStreamClient({
    wsStreamClient: client,
    epicId,
    callbacks,
  });
};

export function __getOpenEpicRegistryForTests(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * Accessor for the module-scoped live-Epic registry. T8 (desktop
 * app-quit intercept) subscribes to this so it can read the aggregated
 * unsynced-edits map without reaching into provider-local state.
 */
export function getOpenEpicRegistry(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * True when the Epic session for `epicId` currently has unsynced edits
 * that the host has not yet proven coverage for. Called synchronously
 * from the tab-close handler to decide whether to pop the discard-
 * confirmation dialog.
 */
export function epicHasUnsyncedEdits(epicId: string): boolean {
  const handle = registry.get(epicId);
  if (handle === null) return false;
  return handle.store.getState().isDirty;
}

/**
 * Release (forcibly dispose) the Epic session for `epicId`. Called when the
 * user closes a tab in the strip.
 */
export function releaseOpenEpicSession(epicId: string): void {
  registry.release(epicId);
}

export function releaseOpenEpicSessionIfUnused(epicId: string): void {
  const state = useEpicCanvasStore.getState();
  const stillOpen = state.openTabOrder.some(
    (tabId) => state.tabsById[tabId]?.epicId === epicId,
  );
  if (stillOpen) return;
  releaseOpenEpicSession(epicId);
}

/**
 * Forcibly dispose every live Epic session. Wired into the auth lifecycle so
 * sign-out, user-switch, or token expiry cannot leave a prior identity's
 * Y.Doc / queue / focus state behind in the registry - the next sign-in
 * starts fresh from a host snapshot.
 */
export function disposeAllOpenEpicSessions(): void {
  registry.disposeAll();
}
