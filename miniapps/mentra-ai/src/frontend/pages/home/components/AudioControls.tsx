import { useState } from "react";
import { useMentraAuth } from "@mentra/react";
import { Mic } from "lucide-react";
import { Card, Button, Input } from "../../../components/ui";
import { createAuthFetch } from "../../../lib/authFetch";

interface AudioControlsProps {
  onLog: (message: string) => void;
}

export function AudioControls({ onLog }: AudioControlsProps) {
  const { frontendToken } = useMentraAuth();
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakText, setSpeakText] = useState("");

  /**
   * POST text to /api/speak and log every step so a silent failure is
   * always traceable from the frontend log panel.
   */
  const handleSpeak = async () => {
    if (!speakText.trim()) {
      onLog("⚠️ TTS: no text to speak");
      return;
    }

    setIsSpeaking(true);
    onLog(`🔊 TTS: sending "${speakText.slice(0, 60)}${speakText.length > 60 ? "…" : ""}"`);

    try {
      const authFetch = createAuthFetch(frontendToken);
      const t0 = performance.now();
      const response = await authFetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speakText }),
      });
      const ms = Math.round(performance.now() - t0);

      let data: any = {};
      try {
        data = await response.json();
      } catch {
        // non-JSON body
      }

      if (response.ok) {
        onLog(`✅ TTS: server accepted (HTTP ${response.status}, ${ms}ms)`);
        const caps = data.capabilities;
        if (caps) {
          onLog(
            `🎛️ glasses: model=${caps.modelName ?? "?"} ` +
              `hasSpeaker=${caps.hasSpeaker} hasDisplay=${caps.hasDisplay}`,
          );
          if (caps.hasSpeaker === false) {
            onLog(
              "🔇 TTS: glasses report NO speaker — audio will not play. " +
                "Device capability issue, not the speak function.",
            );
          } else {
            onLog("👂 TTS: audio sent to glasses — you should hear it now.");
          }
        }
        setSpeakText("");
      } else {
        onLog(`❌ TTS: server rejected (HTTP ${response.status}): ${data.error ?? "unknown error"}`);
      }
    } catch (error) {
      onLog(`❌ TTS: request failed — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsSpeaking(false);
    }
  };

  return (
    <Card className="gap-0 p-0">
      <div className="p-3 flex items-center gap-2 border-b">
        <Mic className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Text-to-Speech</span>
      </div>
      <div className="p-3 flex gap-2">
        <Input
          value={speakText}
          onChange={(e) => setSpeakText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isSpeaking && handleSpeak()}
          placeholder="Type something to speak..."
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          onClick={handleSpeak}
          disabled={isSpeaking || !speakText.trim()}
          className="shrink-0"
        >
          <Mic className={`w-3.5 h-3.5 ${isSpeaking ? "animate-pulse" : ""}`} />
          <span className="hidden sm:inline">{isSpeaking ? "Speaking…" : "Speak"}</span>
        </Button>
      </div>
    </Card>
  );
}
