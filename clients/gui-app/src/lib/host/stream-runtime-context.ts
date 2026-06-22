import { createContext, use } from "react";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Streaming-transport seam. The single `WsStreamClient<HostStreamRpcRegistry>`
 * exposed here rides next to the unary host runtime and powers every
 * Epic / notifications subscription the GUI opens. Tests bypass this entire
 * provider by mounting the per-Epic / notifications stores with injected
 * stream-client factories.
 */
export interface StreamRuntimeBinding {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
}

export const StreamRuntimeContext = createContext<StreamRuntimeBinding | null>(
  null,
);

export function useWsStreamClient(): WsStreamClient<HostStreamRpcRegistry> | null {
  const value = use(StreamRuntimeContext);
  return value === null ? null : value.wsStreamClient;
}

/**
 * Module-level mirror of the app-wide `WsStreamClient`, kept in sync by
 * `HostStreamProvider`. Long-lived, non-React consumers - chiefly the open-epic
 * store's stream factory, which is cached in a module-scoped MRU registry and
 * OUTLIVES any single `EpicSessionProvider` instance - must resolve the CURRENT
 * transport through this getter rather than capturing the client a (now
 * possibly unmounted) provider instance held: a host restart replaces the
 * client and `close()`s the old one, so a captured reference goes stale and
 * subscribing on it throws. Mirrors `getHostBindingSnapshot()` for the unary
 * host runtime. Always holds the live open client or `null`, never a closed one
 * (the provider mirrors only the current `value`, and the current value is
 * never the client being closed).
 */
let liveHostStreamClient: WsStreamClient<HostStreamRpcRegistry> | null = null;

export function setLiveHostStreamClient(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
): void {
  liveHostStreamClient = client;
}

export function getLiveHostStreamClient(): WsStreamClient<HostStreamRpcRegistry> | null {
  return liveHostStreamClient;
}
