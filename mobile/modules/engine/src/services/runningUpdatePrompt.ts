/**
 * The update prompt for a running miniapp.
 *
 * When a newer release is staged for a miniapp the user is running, the
 * engine asks before stopping it. The host renders the prompt (its copy and
 * buttons) and answers it; the engine owns when a prompt may appear: only
 * while the Mentra App is in the foreground, one at a time. After Not now it
 * asks again the next time the person opens that miniapp, and not before.
 */
import {AppState} from "react-native"

import {storage} from "../utils/storage/storage"

export interface RunningUpdatePromptRequest {
  packageName: string
  /** The installed miniapp's name. */
  displayName: string
  /** The staged release's version. */
  version: string
}

export type RunningUpdatePromptAnswer = "update" | "not_now" | "not_shown"

export interface PendingRunningUpdatePrompt extends RunningUpdatePromptRequest {
  answer(choice: "update" | "not_now"): void
}

export interface RunningUpdateFailure {
  packageName: string
  displayName: string
  /** The version the user keeps running. */
  installedVersion: string
}

export interface RunningUpdatePromptEnvironment {
  isForeground(): boolean
  /** The person answered Not now and has not opened the miniapp since. Survives restarts. */
  isDeclined(packageName: string): boolean
  setDeclined(packageName: string, declined: boolean): void
}

const declinedKey = (packageName: string) => `miniapp_update_declined:${packageName}`

const defaultEnvironment: RunningUpdatePromptEnvironment = {
  isForeground: () => AppState.currentState === "active",
  isDeclined: (packageName) => {
    const stored = storage.load<boolean>(declinedKey(packageName))
    return stored.is_ok() && stored.value === true
  },
  setDeclined: (packageName, declined) => {
    if (declined) storage.save(declinedKey(packageName), true)
    else storage.remove(declinedKey(packageName))
  },
}

let environment = defaultEnvironment
const promptListeners = new Set<(prompt: PendingRunningUpdatePrompt) => void>()
const failureListeners = new Set<(failure: RunningUpdateFailure) => void>()
const dueListeners = new Set<(packageName: string) => void>()
let openPrompt: string | null = null
/** Each open prompt's settle function, with its package. */
const openSettlers = new Map<(answer: RunningUpdatePromptAnswer) => void, string>()

/** Whether a prompt for this miniapp would be shown right now. */
export function canShowRunningUpdatePrompt(packageName: string): boolean {
  if (promptListeners.size === 0 || openPrompt !== null || !environment.isForeground()) return false
  return !environment.isDeclined(packageName)
}

/**
 * The person opened `packageName`. After Not now, its waiting update may ask again now: updaters listening with
 * {@link onRunningUpdatePromptDue} try it again.
 */
export function noteMiniappOpened(packageName: string): void {
  if (!environment.isDeclined(packageName)) return
  environment.setDeclined(packageName, false)
  for (const listener of [...dueListeners]) {
    try {
      listener(packageName)
    } catch (error) {
      console.warn("Update prompt due listener threw", error)
    }
  }
}

/** The update the person put off has installed: a later update asks afresh. */
export function forgetRunningUpdateDecline(packageName: string): void {
  if (environment.isDeclined(packageName)) environment.setDeclined(packageName, false)
}

/** Called with a miniapp opened again after Not now, whose waiting update may now ask. Returns an unsubscribe. */
export function onRunningUpdatePromptDue(listener: (packageName: string) => void): () => void {
  dueListeners.add(listener)
  return () => {
    dueListeners.delete(listener)
  }
}

/**
 * Ask the user whether to update a running miniapp now. Resolves "not_shown"
 * without asking when the Mentra App is in the background, another prompt is
 * open, no host listener is registered, or the person answered Not now for
 * this miniapp and has not opened it since.
 */
export function requestRunningUpdatePrompt(request: RunningUpdatePromptRequest): Promise<RunningUpdatePromptAnswer> {
  if (!canShowRunningUpdatePrompt(request.packageName)) return Promise.resolve("not_shown")
  openPrompt = request.packageName
  return new Promise<RunningUpdatePromptAnswer>((resolve) => {
    let settled = false
    const settle = (answer: RunningUpdatePromptAnswer) => {
      if (settled) return
      settled = true
      openSettlers.delete(settle)
      openPrompt = null
      if (answer === "not_now") environment.setDeclined(request.packageName, true)
      resolve(answer)
    }
    openSettlers.set(settle, request.packageName)
    const pending: PendingRunningUpdatePrompt = {
      ...request,
      answer: (choice) => settle(choice === "update" ? "update" : "not_now"),
    }
    try {
      for (const listener of [...promptListeners]) listener(pending)
    } catch (error) {
      console.warn(`Update prompt for ${request.packageName} could not be shown`, error)
      settle("not_shown")
    }
  })
}

/**
 * Settle every open prompt as "not_shown" when the session that asked ends
 * (sign-out or a deployment switch). Nothing is stopped; a later answer from a
 * prompt still on screen is ignored.
 */
export function dismissRunningUpdatePrompts(): void {
  for (const settle of [...openSettlers.keys()]) settle("not_shown")
}

/** Settle the open prompt of `packageName`, if any, as "not_shown": the install that asked no longer wants it. */
export function dismissRunningUpdatePrompt(packageName: string): void {
  for (const [settle, prompted] of [...openSettlers]) if (prompted === packageName) settle("not_shown")
}

/** Host UI: render each prompt and answer it. Returns an unsubscribe function. */
export function onRunningUpdatePrompt(listener: (prompt: PendingRunningUpdatePrompt) => void): () => void {
  promptListeners.add(listener)
  return () => {
    promptListeners.delete(listener)
  }
}

/** Host UI: an accepted update failed and the existing version runs again. */
export function onRunningUpdateFailed(listener: (failure: RunningUpdateFailure) => void): () => void {
  failureListeners.add(listener)
  return () => {
    failureListeners.delete(listener)
  }
}

export function emitRunningUpdateFailed(failure: RunningUpdateFailure): void {
  for (const listener of [...failureListeners]) {
    try {
      listener(failure)
    } catch (error) {
      console.warn("Update failure listener threw", error)
    }
  }
}

/** Tests only: replace the foreground, clock and persistence seams. */
export function setRunningUpdatePromptEnvironmentForTests(next: RunningUpdatePromptEnvironment | null): void {
  environment = next ?? defaultEnvironment
  openPrompt = null
  openSettlers.clear()
  promptListeners.clear()
  failureListeners.clear()
  dueListeners.clear()
}
