/**
 * The update prompt for a running miniapp.
 *
 * When a newer release is staged for a miniapp the user is running, the
 * engine asks before stopping it. The host renders the prompt (its copy and
 * buttons) and answers it; the engine owns when a prompt may appear: only
 * while the Mentra App is in the foreground, one at a time, and at most once
 * a day per miniapp.
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

/** A pending update asks at most once a day per miniapp. */
export const RUNNING_UPDATE_PROMPT_INTERVAL_MS = 86_400_000

export interface RunningUpdatePromptEnvironment {
  isForeground(): boolean
  now(): number
  lastPromptedAt(packageName: string): number | null
  recordPrompted(packageName: string, at: number): void
}

const promptedAtKey = (packageName: string) => `miniapp_update_prompted_at:${packageName}`

const defaultEnvironment: RunningUpdatePromptEnvironment = {
  isForeground: () => AppState.currentState === "active",
  now: () => Date.now(),
  lastPromptedAt: (packageName) => {
    const stored = storage.load<number>(promptedAtKey(packageName))
    return stored.is_ok() && typeof stored.value === "number" ? stored.value : null
  },
  recordPrompted: (packageName, at) => {
    storage.save(promptedAtKey(packageName), at)
  },
}

let environment = defaultEnvironment
const promptListeners = new Set<(prompt: PendingRunningUpdatePrompt) => void>()
const failureListeners = new Set<(failure: RunningUpdateFailure) => void>()
let openPrompt: string | null = null

/** Whether a prompt for this miniapp would be shown right now. */
export function canShowRunningUpdatePrompt(packageName: string): boolean {
  if (promptListeners.size === 0 || openPrompt !== null || !environment.isForeground()) return false
  const last = environment.lastPromptedAt(packageName)
  if (last === null) return true
  const elapsed = environment.now() - last
  // A clock set backwards must not suppress the prompt for an unbounded time.
  return elapsed < 0 || elapsed >= RUNNING_UPDATE_PROMPT_INTERVAL_MS
}

/**
 * Ask the user whether to update a running miniapp now. Resolves "not_shown"
 * without asking when the Mentra App is in the background, another prompt is
 * open, no host listener is registered, or this miniapp was asked within
 * {@link RUNNING_UPDATE_PROMPT_INTERVAL_MS}.
 */
export function requestRunningUpdatePrompt(request: RunningUpdatePromptRequest): Promise<RunningUpdatePromptAnswer> {
  if (!canShowRunningUpdatePrompt(request.packageName)) return Promise.resolve("not_shown")
  openPrompt = request.packageName
  return new Promise<RunningUpdatePromptAnswer>((resolve) => {
    let settled = false
    const settle = (answer: RunningUpdatePromptAnswer) => {
      if (settled) return
      settled = true
      openPrompt = null
      resolve(answer)
    }
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
    environment.recordPrompted(request.packageName, environment.now())
  })
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
  promptListeners.clear()
  failureListeners.clear()
}
