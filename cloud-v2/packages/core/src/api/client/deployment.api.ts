/**
 * @fileoverview `GET /api/client/deployment`: what Mentra's deployment gives every phone.
 *
 * The Mentra App installs each miniapp of `miniapps.defaults` that is missing, in the background, from its
 * deployment's miniapp host (`https://miniapps.mentraglass.com/<packageName>/` and its staging and dev hosts), and
 * keeps it updated from there. A workspace's manifest carries its own list. Unauthenticated: the list is the same
 * for every phone of this Core, and the app reads it before or without a session.
 *
 * The app builds decide which of these are system miniapps (their own code), never this list.
 */

import {Hono} from "hono"
import type {AppEnv} from "../../types/hono.types"

/** Mentra's default miniapps, on dev, staging and production alike. */
export const DEFAULT_MINIAPP_PACKAGES = [
  "com.mentra.ai",
  "com.mentra.call",
  "com.mentra.enterprise",
  "com.mentra.link",
  "com.mentra.livestreamer",
  "com.mentra.merge",
  "com.mentra.notes",
  "com.mentra.captions",
  "com.mentra.navigation",
  "com.mentra.recorder",
  "com.mentra.teleprompter",
  "com.mentra.translation",
] as const

const app = new Hono<AppEnv>()

app.get("/", c => c.json({miniapps: {defaults: DEFAULT_MINIAPP_PACKAGES}}, 200, {"cache-control": "public, max-age=300"}))

export default app
