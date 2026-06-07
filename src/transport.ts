/**
 * Transport abstraction. Usedesk currently serves chat over socket.io
 * (`emit/on "dispatch"`), but the widget bundle also carries a Centrifugo
 * transport (`centrifugoEnabled` accounts publish the SAME action objects
 * into a per-client channel). Keeping the wire behind this interface means
 * a Centrifugo rollout is a second factory, not a client rewrite.
 *
 * Reconnection is the transport's job (socket.io's manager handles it for
 * the default implementation); the client re-INITs on every (re)connect.
 */

import { io } from "socket.io-client";

export interface TransportHandlers {
  /** A server action arrived (`@@chat/current/*`, `@@redbone/*`). */
  // eslint-disable-next-line no-unused-vars
  onAction(action: unknown): void;
  /** Fired on every (re)connect — the client re-sends INIT here. */
  onConnect(): void;
  // eslint-disable-next-line no-unused-vars
  onDisconnect(reason: string): void;
  /** Transport-level failure (connect_error etc.). */
  // eslint-disable-next-line no-unused-vars
  onError(message: string): void;
}

export interface ChatTransport {
  connect(): void;
  disconnect(): void;
  /** Returns false when the wire is down (caller decides what to do). */
  // eslint-disable-next-line no-unused-vars
  send(action: unknown): boolean;
  readonly connected: boolean;
}

// eslint-disable-next-line no-unused-vars
export type TransportFactory = (
  // eslint-disable-next-line no-unused-vars
  url: string,
  // eslint-disable-next-line no-unused-vars
  handlers: TransportHandlers,
) => ChatTransport;

/** Default transport — socket.io v4, mirroring the official widget's opts. */
export const socketIoTransport: TransportFactory = (url, handlers) => {
  const socket = io(url, {
    transports: ["websocket"],
    autoConnect: false,
    randomizationFactor: 0.5,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 30_000,
  });

  socket.on("connect", () => handlers.onConnect());
  socket.on("dispatch", (action: unknown) => handlers.onAction(action));
  socket.on("disconnect", (reason) => handlers.onDisconnect(String(reason)));
  socket.on("connect_error", (err) =>
    handlers.onError(String(err?.message ?? err)),
  );

  return {
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    send: (action) => {
      if (!socket.connected) return false;
      socket.emit("dispatch", action);
      return true;
    },
    get connected() {
      return socket.connected;
    },
  };
};
