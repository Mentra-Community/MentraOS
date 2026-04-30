/**
 * @mentra/miniapp/framework/react
 *
 * The React adapter for the framework primitives. One hook that
 * returns reactive snapshots of the framework's `state` plus a typed
 * proxy over the registered client RPCs.
 *
 * Usage:
 *
 *   import {useMentra} from "@mentra/miniapp/framework/react"
 *   import type * as Client from "../client"
 *   import type {AppState} from "../shared/types"
 *
 *   function MyComponent() {
 *     const mentra = useMentra<AppState, typeof Client>()
 *     return <div>{mentra.state.transcript}</div>
 *   }
 *
 * The state generic types `mentra.state.*` against the AppState shape.
 * The client generic types `mentra.client.*` against the exports of
 * `client/index.ts`. Both fall back to permissive types when omitted.
 */

import {useMemo, useSyncExternalStore} from "react"

import {state, __getClientFns} from "./index"

type ClientFn = (...args: unknown[]) => unknown

/**
 * Type helper: turn a module type (the value-side of a `client/`
 * import) into the function-only proxy shape.
 *
 *   type ClientApi<typeof import("../client")> = {
 *     setDisplayLines: (n: number) => Promise<void>
 *     ...
 *   }
 *
 * Synchronous client functions are wrapped into Promises in v1 (when
 * they may cross a process boundary). v0 returns the raw value, but
 * we type as Promise<Awaited<R>> so app code does not need to change
 * later.
 */
type ClientApi<T> = {
  [K in keyof T as T[K] extends (...args: infer _A) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

export interface MentraSurface<TState, TClient> {
  /** Reactive snapshot of the framework's `state`. Updates trigger re-render. */
  state: TState
  /** Typed proxy over functions registered via `exposeClient({...})`. */
  client: ClientApi<TClient>
}

/**
 * Subscribe a React component to the framework's `state` snapshot, and
 * receive a typed proxy over the registered client RPCs.
 *
 * The two generics are independent. In typical use both are passed:
 *
 *   const mentra = useMentra<AppState, typeof Client>()
 *
 * If you do not need either, the call works with permissive defaults.
 */
export function useMentra<
  TState extends object = Record<string, unknown>,
  TClient = Record<string, never>,
>(): MentraSurface<TState, TClient> {
  const subscribe = useMemo(() => state.subscribe.bind(state), [])
  const getSnapshot = useMemo(() => () => state.getSnapshot(), [])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const client = useMemo(() => createClientProxy<TClient>(), [])

  return {
    state: snapshot as unknown as TState,
    client,
  }
}

function createClientProxy<TClient>(): ClientApi<TClient> {
  return new Proxy({} as ClientApi<TClient>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined
      return async (...args: unknown[]) => {
        const fn = __getClientFns()[prop]
        if (!fn) {
          throw new Error(
            `[@mentra/miniapp/framework] mentra.client.${prop} is not registered. ` +
              `Did you call exposeClient({${prop}}) in client/?`,
          )
        }
        return await (fn as ClientFn)(...args)
      }
    },
  })
}
