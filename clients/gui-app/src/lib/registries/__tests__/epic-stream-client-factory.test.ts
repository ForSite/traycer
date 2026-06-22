import { afterEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import {
  createDefaultEpicStreamClient,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { setLiveHostStreamClient } from "@/lib/host/stream-runtime-context";

/** Inert socket so a real `WsStreamClient` can be built without a server. */
class StubSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  send(): void {
    // Inert: nothing is read off this socket in these tests.
  }
  close(): void {
    // Inert: no real connection to tear down.
  }
}

const stubFactory: IStreamWebSocketFactory = {
  create(): StreamWebSocketLike {
    return new StubSocket();
  },
};

function makeClient(): WsStreamClient<HostStreamRpcRegistry> {
  return new WsStreamClient({
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    webSocketFactory: stubFactory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    // High so the reconnect backoff timer never fires during a test.
    initialBackoffMs: 10_000_000,
    maxBackoffMs: 10_000_000,
  });
}

function noopCallbacks(): EpicStreamCallbacks {
  return {
    onSnapshot: () => undefined,
    onEarlyMeta: () => undefined,
    onUpdate: () => undefined,
    onAwareness: () => undefined,
    onPermissionChanged: () => undefined,
    onEpicDeleted: () => undefined,
    onArtifactRoomSnapshot: () => undefined,
    onArtifactRoomUpdate: () => undefined,
    onArtifactRoomAwareness: () => undefined,
    onArtifactRoomState: () => undefined,
    onCloudSyncStatus: () => undefined,
    onMigrationStarted: () => undefined,
    onMigrationProgress: () => undefined,
    onMigrationFailed: () => undefined,
    onMigrationNotAllowed: () => undefined,
    onConnectionStatus: () => undefined,
  };
}

afterEach(() => {
  setLiveHostStreamClient(null);
  __setEpicStreamClientFactoryForTests(null);
});

describe("createDefaultEpicStreamClient", () => {
  it("degrades to an inert no-op stream when no live transport is registered", () => {
    setLiveHostStreamClient(null);
    // No throw, and the pending stream is callable: outbound ops + close are
    // safe no-ops until the provider re-opens it on a live client.
    expect(() => {
      const stream = createDefaultEpicStreamClient("epic-a", noopCallbacks());
      stream.applyUpdate(new Uint8Array());
      stream.close();
    }).not.toThrow();
  });

  it("subscribes on whichever client the live snapshot currently points to", () => {
    const live = makeClient();
    setLiveHostStreamClient(live);

    const stream = createDefaultEpicStreamClient("epic-a", noopCallbacks());
    expect(stream).not.toBeNull();
    stream.close();
  });

  it("resolves the CURRENT live client after a host restart swaps the transport", () => {
    // Old transport: open, then closed by the stream provider on restart - and
    // the snapshot is repointed at the fresh client. The factory has no captured
    // reference, so it must use the new (open) client and never the closed one.
    const closedOld = makeClient();
    closedOld.close();
    const freshLive = makeClient();
    setLiveHostStreamClient(freshLive);

    expect(() => {
      const stream = createDefaultEpicStreamClient("epic-a", noopCallbacks());
      stream.close();
    }).not.toThrow();
  });

  it("surfaces the closed-client error only when the snapshot itself is closed", () => {
    // Proves the factory reads the snapshot at call time (no capture): a closed
    // client in the snapshot is the ONLY way to reach the transport's guard.
    const closed = makeClient();
    closed.close();
    setLiveHostStreamClient(closed);

    expect(() =>
      createDefaultEpicStreamClient("epic-a", noopCallbacks()),
    ).toThrow(/closed WsStreamClient/);
  });

  it("delegates to the test override when one is installed", () => {
    const override = vi.fn(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));
    __setEpicStreamClientFactoryForTests(override);
    // No live client set: delegation must happen before the snapshot lookup.
    const callbacks = noopCallbacks();

    createDefaultEpicStreamClient("epic-a", callbacks);
    expect(override).toHaveBeenCalledWith("epic-a", callbacks);
  });
});
