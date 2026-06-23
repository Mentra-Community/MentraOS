import { memo } from "react";
import "./ChromaticBorder.css";

interface ChromaticBorderProps {
  state?: "idle" | "active" | "pulse";
  borderRadius?: number;
}

export const ChromaticBorder = memo(function ChromaticBorder({
  state = "active",
  borderRadius = 0,
}: ChromaticBorderProps) {
  const glowClass =
    state === "pulse"
      ? "chromatic-pulse"
      : state === "active"
        ? "chromatic-active"
        : "chromatic-idle";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
        borderRadius,
        opacity: state === "idle" ? 0 : 1,
        transition: "opacity 0.3s ease-out",
        willChange: "opacity",
        contain: "strict",
      }}
    >
      <div
        className={`chromatic-glow chromatic-glow-1 ${glowClass}`}
        style={{ borderRadius, willChange: "transform" }}
      />
      <div
        className={`chromatic-glow chromatic-glow-2 ${glowClass}`}
        style={{ borderRadius, willChange: "transform" }}
      />
      <div
        className="chromatic-cover"
        style={{
          inset: 6,
          borderRadius: Math.max(0, borderRadius - 6),
          backgroundColor: "var(--background)",
        }}
      />
    </div>
  );
});
