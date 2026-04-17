import {create} from "zustand"

import {WebSocketStatus} from "@/services/ws-types"

interface ConnectionState {
  status: WebSocketStatus
  url: string | null
  error: string | null
  lastConnectedAt: Date | null
  lastDisconnectedAt: Date | null
  reconnectAttempts: number

  setStatus: (status: WebSocketStatus) => void
  setUrl: (url: string | null) => void
  setError: (error: string | null) => void
  incrementReconnectAttempts: () => void
  resetReconnectAttempts: () => void
  reset: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: WebSocketStatus.DISCONNECTED,
  url: null,
  error: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  reconnectAttempts: 0,

  setStatus: (status) =>
    set((state) => ({
      status,
      error: status === WebSocketStatus.ERROR ? state.error : null,
      lastConnectedAt: status === WebSocketStatus.CONNECTED ? new Date() : state.lastConnectedAt,
      lastDisconnectedAt:
        status === WebSocketStatus.DISCONNECTED || status === WebSocketStatus.ERROR
          ? new Date()
          : state.lastDisconnectedAt,
    })),

  setUrl: (url) => set({url}),

  setError: (error) => set({error, status: WebSocketStatus.ERROR, lastDisconnectedAt: new Date()}),

  incrementReconnectAttempts: () =>
    set((state) => ({
      reconnectAttempts: state.reconnectAttempts + 1,
    })),

  resetReconnectAttempts: () => set({reconnectAttempts: 0}),

  reset: () =>
    set({
      status: WebSocketStatus.DISCONNECTED,
      url: null,
      error: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      reconnectAttempts: 0,
    }),
}))
