import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/speak", speak)
app.post("/stop", stopAudio)
app.post("/tone/start", startTone)
app.post("/tone/stop", stopTone)

// ─── Tone generator state (per-user) ────────────────────────────────────────

interface ToneState {
  timer: ReturnType<typeof setInterval>
  startedAt: number
}

const activeTones = new Map<string, ToneState>()

// ─── Sine wave PCM generator ─────────────────────────────────────────────────

/**
 * Generate a buffer of PCM 16-bit mono sine wave samples.
 *
 * @param frequency  Tone frequency in Hz (e.g. 440 for A4)
 * @param sampleRate Samples per second (24000 for our output stream)
 * @param durationMs Duration of this chunk in milliseconds
 * @param phase      Current phase offset in radians (for seamless chunking)
 * @returns { buffer, nextPhase }
 */
function generateSinePCM(
  frequency: number,
  sampleRate: number,
  durationMs: number,
  phase: number,
): {buffer: Buffer; nextPhase: number} {
  const numSamples = Math.floor(sampleRate * (durationMs / 1000))
  const buf = Buffer.alloc(numSamples * 2) // 16-bit = 2 bytes per sample
  const twoPi = 2 * Math.PI
  const phaseIncrement = (twoPi * frequency) / sampleRate

  let currentPhase = phase
  for (let i = 0; i < numSamples; i++) {
    // 0.8 amplitude to avoid clipping
    const sample = Math.round(Math.sin(currentPhase) * 0.8 * 32767)
    buf.writeInt16LE(sample, i * 2)
    currentPhase += phaseIncrement
    // Keep phase in [0, 2π) to avoid floating point drift
    if (currentPhase >= twoPi) currentPhase -= twoPi
  }

  return {buffer: buf, nextPhase: currentPhase}
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** POST /speak — text-to-speech on the glasses */
async function speak(c: Context) {
  const {text, userId} = await c.req.json()

  if (!text) return c.json({error: "text is required"}, 400)
  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    await userSession.audio.speak(text)
    return c.json({success: true, message: "Text-to-speech started", userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

/** POST /stop — stop audio playback */
async function stopAudio(c: Context) {
  const {userId} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    await userSession.audio.stopAudio()
    return c.json({success: true, message: "Audio stopped", userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

/**
 * POST /tone/start — start streaming a sine wave tone through the audio output stream.
 *
 * Body: { userId, frequency? }
 *   frequency: Hz (default 440 = A4). Try 880 for a higher pitch.
 *
 * Creates an AudioOutputStream and writes 20ms PCM chunks every 20ms.
 * The tone plays until POST /tone/stop is called.
 * Use this to measure end-to-end audio streaming latency.
 */
async function startTone(c: Context) {
  const {userId, frequency: freqParam} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: "Glasses not connected"}, 503)
  }

  // Stop any existing tone for this user
  await cleanupTone(userId)

  const frequency = freqParam || 440
  const sampleRate = 24000
  const chunkMs = 20 // 20ms chunks = low latency, smooth playback

  try {
    // Claim the shared output stream for tone playback.
    const stream = await userSession.outputStream.claim("tone")

    const startedAt = Date.now()
    let phase = 0

    console.log(`[Tone] Started ${frequency}Hz sine wave for ${userId} (stream: ${stream.streamUrl})`)

    // Write a chunk immediately so there's no delay on the first frame
    const first = generateSinePCM(frequency, sampleRate, chunkMs, phase)
    stream.write(first.buffer)
    phase = first.nextPhase

    // Then keep writing every chunkMs
    const timer = setInterval(() => {
      if (stream.state !== "streaming") {
        cleanupTone(userId)
        return
      }
      if (!userSession.outputStream.isOwnedBy("tone")) {
        cleanupTone(userId)
        return
      }
      try {
        const {buffer, nextPhase} = generateSinePCM(frequency, sampleRate, chunkMs, phase)
        stream.write(buffer)
        phase = nextPhase
      } catch {
        // Stream closed — cleanup
        cleanupTone(userId)
      }
    }, chunkMs)

    activeTones.set(userId, {timer, startedAt})

    return c.json({
      success: true,
      message: `Tone started: ${frequency}Hz`,
      frequency,
      streamUrl: stream.streamUrl,
      userId,
    })
  } catch (error: any) {
    if (error?.code === "AUDIO_OUTPUT_BUSY") {
      return c.json({error: error.message}, 409)
    }
    console.error("[Tone] Failed to start:", error.message)
    return c.json({error: error.message}, 500)
  }
}

/**
 * POST /tone/stop — stop the sine wave tone.
 *
 * Body: { userId }
 */
async function stopTone(c: Context) {
  const {userId} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const tone = activeTones.get(userId)
  if (!tone) {
    return c.json({success: true, message: "No active tone (already stopped)", userId})
  }

  const durationMs = Date.now() - tone.startedAt
  await cleanupTone(userId)

  console.log(`[Tone] Stopped for ${userId} after ${durationMs}ms`)

  return c.json({
    success: true,
    message: `Tone stopped after ${durationMs}ms`,
    durationMs,
    userId,
  })
}

/** Clean up a tone for a user — stop the interval and end the stream. */
async function cleanupTone(userId: string): Promise<void> {
  const tone = activeTones.get(userId)
  if (!tone) return

  clearInterval(tone.timer)
  activeTones.delete(userId)
  await UserSession.get(userId)?.outputStream.release("tone", true)
}

export default app
