/**
 * API Routes
 *
 * Mounts each feature as a scoped Hono sub-app.
 * Every feature owns its own routes — no conflicts possible.
 *
 * GET  /health
 *
 * POST /audio/speak
 * POST /audio/stop
 *
 * GET  /photo/latest
 * GET  /photo/:requestId
 * GET  /photo/:requestId/base64
 *
 * GET  /storage/theme
 * POST /storage/theme
 *
 * GET  /stream/photo
 * GET  /stream/transcription
 */

import {Hono} from "hono"
import audio from "./audio.api"
import photo from "./photo.api"
import storage from "./storage.api"
import stream from "./stream.api"

const api = new Hono()

// Health (standalone, no sub-app needed)
api.get("/health", (c) => c.json({status: "ok", timestamp: new Date().toISOString()}))

// Feature sub-apps
api.route("/audio", audio)
api.route("/photo", photo)
api.route("/storage", storage)
api.route("/stream", stream)

export {api}
