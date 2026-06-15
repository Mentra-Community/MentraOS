import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "../../../components/ui";

interface WakeGlowButtonProps {
  /** Optional log sink shared with the rest of the Debug overlay. */
  onLog?: (message: string) => void;
}

/**
 * Type for the window-level dev hook ChatInterface installs so the Debug
 * overlay can flip the chromatic activation ring on without going through
 * the SSE round-trip. Pure UI preview — does NOT send anything to the
 * glasses / server.
 *
 * Kept on `window` (rather than via React context) because the Debug
 * overlay is a sibling of ChatInterface and we don't want to thread a
 * setter through props for a dev-only escape hatch.
 */
declare global {
  interface Window {
    /** Force the chromatic ring on (true) or off (false). Stays in that
     *  state until called again — no auto-revert. */
    __setDevWakeWord?: (on: boolean) => void;
  }
}

/**
 * Toggles the activation glow (the chromatic ring around the chat) on/off
 * so a developer can preview the wake-word UI without actually saying the
 * wake phrase. Local-only, no network round-trip.
 *
 * The glow stays on until you tap the button again — useful for inspecting
 * the animation, screenshotting, or holding it on for a demo recording.
 */
export function WakeGlowButton({ onLog }: WakeGlowButtonProps) {
  const [on, setOn] = useState(false);

  const log = (msg: string) => {
    console.log(`[WAKE-GLOW] ${msg}`);
    onLog?.(msg);
  };

  // If the page unmounts (e.g. ChatInterface re-renders away from us),
  // make sure we clean up the glow so it isn't stuck on.
  useEffect(() => {
    return () => {
      window.__setDevWakeWord?.(false);
    };
  }, []);

  const toggle = () => {
    const set = window.__setDevWakeWord;
    if (!set) {
      log("⚠️ Wake glow hook not installed yet — open the chat first.");
      return;
    }
    const next = !on;
    set(next);
    setOn(next);
    log(next ? "✨ Wake glow ON" : "🌑 Wake glow OFF");
  };

  return (
    <Button size="sm" variant={on ? "destructive" : "default"} onClick={toggle}>
      {on ? <X className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
      <span>{on ? "Stop wake glow" : "Trigger wake glow"}</span>
    </Button>
  );
}
