import { useState } from "react";
import { useMentraAuth } from "@mentra/react";
import { Music, AudioLines } from "lucide-react";
import { Button } from "../../../components/ui";
import { createAuthFetch } from "../../../lib/authFetch";

interface SoundTestButtonsProps {
  /** Optional log sink — every step of the test is reported here. */
  onLog?: (message: string) => void;
}

/**
 * Two dev-only buttons that fire the start.mp3 and popping.mp3 sounds the
 * same way the real pipeline does (server-side `session.audio.playAudio`
 * with the URL derived from PUBLIC_URL). Useful for isolating whether
 * playAudio itself is the problem in prod, separately from whether the
 * wake-word path is working.
 *
 * Logs the full server response — duration, success flag, error if any —
 * to the shared action log so you can see exactly what playAudio reports.
 */
export function SoundTestButtons({ onLog }: SoundTestButtonsProps) {
  const { frontendToken } = useMentraAuth();
  const [busyStart, setBusyStart] = useState(false);
  const [busyPopping, setBusyPopping] = useState(false);

  const fire = async (
    kind: "start" | "popping",
    setBusy: (b: boolean) => void,
  ) => {
    const label = kind === "start" ? "start.mp3" : "popping.mp3";
    setBusy(true);

    const log = (msg: string) => {
      console.log(`[SOUND-TEST] ${msg}`);
      onLog?.(msg);
    };

    log(`🎵 ${label}: requesting playback…`);

    if (!frontendToken) {
      log("⚠️ no MentraOS auth token — open this MiniApp from the MentraOS app.");
      setBusy(false);
      return;
    }

    try {
      const authFetch = createAuthFetch(frontendToken);
      const t0 = performance.now();
      const res = await authFetch(`/api/debug/play-${kind}`, { method: "POST" });
      const ms = Math.round(performance.now() - t0);

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        /* non-JSON body */
      }

      if (!res.ok) {
        log(`❌ ${label}: server rejected (HTTP ${res.status}, ${ms}ms) — ${data.error ?? "unknown error"}`);
        return;
      }

      log(`✅ ${label}: server accepted (HTTP ${res.status}, ${ms}ms)`);
      if (data.url) log(`🌐 url: ${data.url}`);
      if (typeof data.durationMs === "number") log(`⏱  server-side playAudio took ${data.durationMs}ms`);

      const pb = data.playback;
      if (pb) {
        if (pb.success === false) {
          log(`🔇 ${label}: glasses reported FAILED — ${pb.error ?? "unknown"}`);
        } else if (pb.success === true) {
          log(`👂 ${label}: glasses confirmed playback${pb.duration ? ` (${pb.duration}s)` : ""}`);
        } else {
          log(`📤 ${label}: request sent (no playback confirmation)`);
        }
      }
    } catch (err) {
      log(`❌ ${label}: request failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="default"
        onClick={() => fire("start", setBusyStart)}
        disabled={busyStart}
      >
        <AudioLines className={`w-3.5 h-3.5 ${busyStart ? "animate-pulse" : ""}`} />
        <span>{busyStart ? "Playing start…" : "Play start.mp3"}</span>
      </Button>
      <Button
        size="sm"
        variant="default"
        onClick={() => fire("popping", setBusyPopping)}
        disabled={busyPopping}
      >
        <Music className={`w-3.5 h-3.5 ${busyPopping ? "animate-pulse" : ""}`} />
        <span>{busyPopping ? "Playing popping…" : "Play popping.mp3"}</span>
      </Button>
    </>
  );
}
