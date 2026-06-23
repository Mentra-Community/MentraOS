/**
 * Visual Query Classifier (client) — thin backend client.
 *
 * Asks the backend (/api/classify) whether a query needs the camera photo to
 * answer. The Gemini call runs server-side; this is just an authenticated
 * fetch. Returns false on any error (defaults to the fast / non-visual path).
 *
 * NOTE: currently unused by the pipeline — the app pre-captures a photo at
 * wake-word time and lets the agent prompt do visual/non-visual classification.
 * Kept as a ready, backend-routed helper if a pre-classification step is wired.
 */

import type {MiniappSession} from "@mentra/miniapp/background"

import {BACKEND_ROUTES} from "../lib/ai-config"

/** Classify whether a query requires visual context (photo from camera). */
export async function isVisualQuery(session: MiniappSession, query: string): Promise<boolean> {
  try {
    const res = await session.auth.fetch(BACKEND_ROUTES.classify(), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({query}),
    })
    if (!res.ok) {
      console.warn(`Visual classifier HTTP ${res.status}`)
      return false
    }
    const body = (await res.json()) as {visual?: boolean}
    return body.visual === true
  } catch (error) {
    console.warn("Visual classifier failed, defaulting to non-visual:", error)
    return false
  }
}
