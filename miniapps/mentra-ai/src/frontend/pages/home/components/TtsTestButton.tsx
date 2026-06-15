import { useState } from "react";
import { useMentraAuth } from "@mentra/react";
import { Volume2 } from "lucide-react";
import { Button } from "../../../components/ui";
import { createAuthFetch } from "../../../lib/authFetch";

interface TtsTestButtonProps {
  /** Optional log sink — every step of the test is reported here. */
  onLog?: (message: string) => void;
}

const TEST_PHRASE =
  "This is a Mentra A I text to speech test. If you can hear this, the speak function works.";

/**
 * One-click TTS test trigger.
 *
 * Sends a fixed phrase to POST /api/speak and logs each step — to the
 * onLog panel if provided, and always to the browser console — so a
 * silent failure is fully traceable.
 */
export function TtsTestButton({ onLog }: TtsTestButtonProps) {
  const { frontendToken } = useMentraAuth();
  const [busy, setBusy] = useState(false);

  const log = (msg: string) => {
    console.log(`[TTS-TEST] ${msg}`);
    onLog?.(msg);
  };

  const runTest = async () => {
    setBusy(true);
    log(`🔊 TTS test: sending fixed phrase…`);

    if (!frontendToken) {
      log(
        "⚠️ TTS test: no MentraOS auth token. TTS plays on the glasses — " +
          "open this MiniApp from the MentraOS app with glasses connected. " +
          "Sending anyway to show the server response…",
      );
    }

    try {
      const authFetch = createAuthFetch(frontendToken);
      const t0 = performance.now();
      const response = await authFetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: TEST_PHRASE }),
      });
      const ms = Math.round(performance.now() - t0);

      let data: any = {};
      try {
        data = await response.json();
      } catch {
        // non-JSON body
      }

      if (response.ok) {
        log(`✅ TTS test: server accepted (HTTP ${response.status}, ${ms}ms)`);

        const caps = data.capabilities;
        if (caps) {
          log(
            `🎛️ glasses: model=${caps.modelName ?? "?"} ` +
              `hasSpeaker=${caps.hasSpeaker} hasDisplay=${caps.hasDisplay}`,
          );
        }

        if (data.ttsBaseUrl) {
          log(`🌐 cloud WS URL: ${data.ttsBaseUrl}`);
        } else {
          log("⚠️ TTS test: no cloud URL — cannot build the TTS endpoint.");
        }

        // playback is the SDK AudioPlayResult — the real device outcome.
        const pb = data.playback;
        if (pb) {
          if (pb.success === false) {
            log(`🔇 TTS test: glasses reported playback FAILED — ${pb.error ?? "unknown error"}`);
          } else if (pb.success === true) {
            log(
              `👂 TTS test: glasses confirmed playback` +
                (pb.duration ? ` (${pb.duration}s)` : "") +
                " — you should have heard it.",
            );
          } else {
            // success === null: fire-and-forget, request sent but not confirmed
            log("📤 TTS test: request sent to glasses (no playback confirmation).");
          }
        }

        if (caps?.hasSpeaker === false) {
          log("🔇 Note: glasses report NO speaker — that device cannot play audio.");
        }
      } else {
        log(`❌ TTS test: server rejected (HTTP ${response.status}): ${data.error ?? "unknown error"}`);
      }
    } catch (error) {
      log(`❌ TTS test: request failed — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="default" onClick={runTest} disabled={busy}>
      <Volume2 className={`w-3.5 h-3.5 ${busy ? "animate-pulse" : ""}`} />
      <span>{busy ? "Testing TTS…" : "Run TTS test"}</span>
    </Button>
  );
}
