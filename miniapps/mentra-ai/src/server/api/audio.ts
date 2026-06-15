import type { SessionContext } from "../utils/auth";

/** POST /speak: text-to-speech on the glasses */
export async function speak(c: SessionContext) {
  const user = c.get("user");

  const { text } = await c.req.json();
  if (!text) {
    console.warn(`🔊 [/api/speak] rejected: no text  user=${user.userId}`);
    return c.json({ error: "text is required" }, 400);
  }

  console.log(`🔊 [/api/speak] request  user=${user.userId}  text="${String(text).slice(0, 80)}"`);

  // requireSession proved we have a User, but the User can exist
  // without an attached glasses connection (soft disconnect, grace
  // period). Speaking needs the radio.
  if (!user.appSession) {
    console.warn(`🔊 [/api/speak] no active glasses session  user=${user.userId}`);
    return c.json({ error: "No active session" }, 404);
  }

  // Log what the glasses report — the #1 reason TTS is silent is the
  // device not advertising a speaker capability.
  const caps = user.appSession.capabilities;
  console.log(
    `🔊 [/api/speak] capabilities  model=${caps?.modelName ?? "unknown"}  ` +
      `hasSpeaker=${caps?.hasSpeaker ?? "?"}  hasDisplay=${caps?.hasDisplay ?? "?"}`,
  );

  // AudioManager.speak() builds the TTS URL from the cloud WS URL,
  // stripping the `/ws/miniapp` path the SDK mishandles. Log the raw
  // WS URL so the derived /api/tts endpoint is verifiable.
  const wsUrl = user.appSession.getServerUrl?.();
  console.log(`🔊 [/api/speak] cloud WS URL = ${wsUrl ?? "undefined"}`);

  try {
    const t0 = Date.now();
    const result = await user.audio.speak(text);
    // result is the SDK AudioPlayResult: { success, error?, duration? }
    console.log(
      `🔊 [/api/speak] audio.speak() resolved in ${Date.now() - t0}ms  ` +
        `success=${result?.success}  duration=${result?.duration ?? "n/a"}  ` +
        `error=${result?.error ?? "none"}  user=${user.userId}`,
    );
    return c.json({
      success: result?.success ?? true,
      message: "Text-to-speech started",
      playback: {
        success: result?.success ?? null,
        duration: result?.duration ?? null,
        error: result?.error ?? null,
      },
      ttsBaseUrl: wsUrl ?? null,
      capabilities: {
        modelName: caps?.modelName ?? null,
        hasSpeaker: caps?.hasSpeaker ?? null,
        hasDisplay: caps?.hasDisplay ?? null,
      },
    });
  } catch (error: any) {
    console.error(`🔊 [/api/speak] audio.speak() FAILED  user=${user.userId}:`, error);
    return c.json({ error: error.message }, 500);
  }
}

/** POST /stop-audio: stop audio playback */
export async function stopAudio(c: SessionContext) {
  const user = c.get("user");

  if (!user.appSession) {
    return c.json({ error: "No active session" }, 404);
  }

  try {
    await user.audio.stopAudio();
    return c.json({ success: true, message: "Audio stopped" });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
}
