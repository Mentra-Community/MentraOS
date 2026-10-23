/**
 * The update prompt for a running miniapp.
 *
 * When a newer release is staged for a miniapp the user is running, the
 * engine asks before stopping it. The host renders the prompt (its copy and
 * buttons) and answers it; the engine owns when a prompt may appear: only
 * while the Mentra App is in the foreground, one at a time, and once per run
 * of a miniapp. After "Not now" it asks again the next time the miniapp is
 * opened, and not before.
 */
import {AppState} from "react-native"

import {miniappRunningRegistry} from "./MiniappRunningRegistry"

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
  /** Whether this run of the miniapp was already asked about an update. */
  wasPromptedThisRun(packageName: string): boolean
  recordPrompted(packageName: string): void
}

/** Miniapps asked during their current run. A miniapp leaves the set when it stops. */
const promptedRuns = new Set<string>()
let unsubscribeRunTracking: (() => void) | null = null

function forgetStoppedRuns(): void {
  for (const packageName of [...promptedRuns]) {
    if (!miniappRunningRegistry.has(packageName)) promptedRuns.delete(packageName)
  }
  if (promptedRuns.size === 0) {
    unsubscribeRunTracking?.()
    unsubscribeRunTracking = null
  }
}

const defaultEnvironment: RunningUpdatePromptEnvironment = {
  isForeground: () => AppState.currentState === "active",
  wasPromptedThisRun: (packageName) => promptedRuns.has(packageName),
  recordPrompted: (packageName) => {
    promptedRuns.add(packageName)
    unsubscribeRunTracking ??= miniappRunningRegistry.subscribe(forgetStoppedRuns)
  },
}

let environment = defaultEnvironment
const promptListeners = new Set<(prompt: PendingRunningUpdatePrompt) => void>()
const failureListeners = new Set<(failure: RunningUpdateFailure) => void>()
let openPrompt: string | null = null
const openSettlers = new Set<(answer: RunningUpdatePromptAnswer) => void>()

/** Whether a prompt for this miniapp would be shown right now. */
export function canShowRunningUpdatePrompt(packageName: string): boolean {
  if (promptListeners.size === 0 || openPrompt !== null || !environment.isForeground()) return false
  return !environment.wasPromptedThisRun(packageName)
}

/**
 * Ask the user whether to update a running miniapp now. Resolves "not_shown"
 * without asking when the Mentra App is in the background, another prompt is
 * open, no host listener is registered, or this run of the miniapp was
 * already asked.
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
      resolve(answer)
    }
    openSettlers.add(settle)
    const pending: PendingRunningUpdatePrompt = {
      ...request,
      answer: (choice) => settle(choice === "update" ? "update" : "not_now"),
    }
    try {
      for (const listener of [...promptListeners]) listener(pending)
    } catch (error) {
      console.warn(`Update prompt for ${request.packageName} could not be shown`, error)
      settle("not_shown")
      return
    }
    environment.recordPrompted(request.packageName)
  })
}

/**
 * Settle every open prompt as "not_shown" when the session that asked ends
 * (sign-out or a deployment switch). Nothing is stopped; a later answer from a
 * prompt still on screen is ignored.
 */
export function dismissRunningUpdatePrompts(): void {
  for (const settle of [...openSettlers]) settle("not_shown")
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

/** Tests only: replace the foreground and run-tracking seams. */
export function setRunningUpdatePromptEnvironmentForTests(next: RunningUpdatePromptEnvironment | null): void {
  environment = next ?? defaultEnvironment
  promptedRuns.clear()
  unsubscribeRunTracking?.()
  unsubscribeRunTracking = null
  openPrompt = null
  openSettlers.clear()
  promptListeners.clear()
  failureListeners.clear()
}
