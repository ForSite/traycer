import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  createOpenEpicStore,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  createDefaultEpicStreamClient,
  EpicSessionContext,
  getOpenEpicRegistry,
  handleHostIds,
  handleStreamClients,
} from "@/lib/registries/epic-session-registry";

export interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

interface MountedSessionState {
  readonly key: string;
  readonly handle: OpenEpicStoreHandle;
}

export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
  // Used only to detect a transport swap (host restart) and re-open the reused
  // session on the new client. The factory itself resolves the live transport
  // from a module snapshot, not from this React value - see
  // `createDefaultEpicStreamClient`.
  const wsStreamClient = useWsStreamClient();
  const activeHostId = useReactiveActiveHostId();
  const authService = useAuthService();
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // Persisted state (`lastFocusedArtifactId`) is bucketed under the active
  // user's email so a different signed-in identity on this device cannot
  // restore prior-user focus state. Email is the only stable identity field
  // surfaced through `AuthProfile`; null means signed-out / hydrating.
  const userId = useAuthStore((state) => state.profile?.email ?? null);

  // When the host terminates the epic stream with `UNAUTHORIZED`, the
  // current context bearer is no longer accepted. Re-validate the live
  // RequestContext: AuthnV3 either confirms/rotates it (transient host
  // miss; a future reconnect will succeed) or rejects it (cascade to sign-out
  // so the user can re-authenticate). This is an event emitted by the acquired
  // session, not a reason to reacquire the session if the auth service object
  // changes identity.
  const onAuthError = useEffectEvent((): void => {
    void authService.revalidateCurrentContext();
  });

  const ownershipKey =
    desktopBridge === null
      ? "browser"
      : `${desktopBridge.windowId}\x1f${epicId}\x1f${tabId}`;
  const [claimedOwnershipKey, setClaimedOwnershipKey] = useState<string | null>(
    () => (desktopBridge === null ? ownershipKey : null),
  );
  const ownershipClaimed =
    desktopBridge === null || claimedOwnershipKey === ownershipKey;

  // Desktop only: claim single-window ownership before acquiring a live epic
  // session. The provider still renders its children while this guard runs;
  // session-bound slots see a null context and show their own loading content.
  useEffect(() => {
    if (desktopBridge === null) return;

    const lifecycle = { cancelled: false };
    let claimHeld = false;
    void (async () => {
      const claim = await claimDesktopEpicOwnership(tabId, epicId);
      if (lifecycle.cancelled) {
        if (claim.ok) {
          await releaseDesktopEpicOwnership(tabId);
        }
        return;
      }
      if (claim.ok) {
        claimHeld = true;
        setClaimedOwnershipKey(ownershipKey);
        return;
      }
      const cleanupPatch = useEpicCanvasStore.getState().discardTabState(tabId);
      if (cleanupPatch !== null) {
        await desktopBridge.perWindowState.update(cleanupPatch);
      }
      getOpenEpicRegistry().release(epicId);
      await desktopBridge.requestFocus(claim.currentOwner);
      void navigate({ to: "/epics", replace: true });
    })();

    return () => {
      lifecycle.cancelled = true;
      if (claimHeld) {
        void releaseDesktopEpicOwnership(tabId);
      }
    };
  }, [desktopBridge, epicId, navigate, ownershipKey, tabId]);

  const sessionKey = `${epicId}\x1f${activeHostId ?? "host:none"}\x1f${userId ?? "user:none"}`;
  const [session, setSession] = useState<MountedSessionState | null>(null);

  useEffect(() => {
    if (!ownershipClaimed) return;
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const existing = registry.get(epicId);
    if (existing !== null) {
      const existingHostId = handleHostIds.get(existing) ?? null;
      if (existing.userId !== userId || existingHostId !== activeHostId) {
        registry.release(epicId);
      }
    }
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    const nextHandle = registry.acquireMounted(epicId, (id) =>
      createOpenEpicStore({
        epicId: id,
        streamClientFactory: createDefaultEpicStreamClient,
        userId,
        onAuthError: handleSessionAuthError,
      }),
    );
    handleHostIds.set(nextHandle, activeHostId);
    // Reconcile the (possibly reused) session's transport with the current live
    // client. The factory always subscribes on the live client - or an inert
    // pending stream when none is live yet - so a freshly created handle
    // (no record) is already on the right transport and we only record it. A
    // REUSED handle whose recorded transport differs from the current one (a
    // host restart, or recovery from a pending no-transport window) is re-opened
    // on the current client; the dead/pending stream never recovers on its own.
    const recordedClient = handleStreamClients.get(nextHandle);
    if (recordedClient === undefined) {
      handleStreamClients.set(nextHandle, wsStreamClient);
    } else if (recordedClient !== wsStreamClient) {
      nextHandle.requestFreshSnapshot();
      handleStreamClients.set(nextHandle, wsStreamClient);
    }
    queueMicrotask(() => {
      if (lifecycle.cancelled) return;
      setSession({ key: sessionKey, handle: nextHandle });
    });

    return () => {
      lifecycle.cancelled = true;
      getOpenEpicRegistry().releaseMounted(epicId);
    };
  }, [
    activeHostId,
    epicId,
    ownershipClaimed,
    sessionKey,
    userId,
    wsStreamClient,
  ]);

  const handle =
    ownershipClaimed && session?.key === sessionKey ? session.handle : null;

  return (
    <EpicSessionContext.Provider value={handle}>
      {children}
    </EpicSessionContext.Provider>
  );
}
