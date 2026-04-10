import React, { useRef, useEffect, useState, useCallback } from "react";
import WHEPClient from "./WHEPClient";

interface WebRTCPlayerProps {
  url: string;
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  showFullscreenButton?: boolean;
}

/**
 * WebRTC (WHEP) video player for sub-second latency playback.
 * Connects to a Cloudflare WHEP endpoint and renders to a <video> element.
 */
export const WebRTCPlayer: React.FC<WebRTCPlayerProps> = ({
  url,
  muted = true,
  onMutedChange,
  showFullscreenButton = true,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WHEPClient | null>(null);
  const [connectionState, setConnectionState] = useState<string>("new");
  const [hasError, setHasError] = useState(false);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const connect = useCallback(() => {
    if (!videoRef.current || !url) return;

    if (clientRef.current) {
      clientRef.current.destroy();
      clientRef.current = null;
    }

    setHasError(false);
    setConnectionState("connecting");

    try {
      const client = new WHEPClient(url, videoRef.current);
      clientRef.current = client;

      const stateInterval = setInterval(() => {
        if (!clientRef.current) {
          clearInterval(stateInterval);
          return;
        }
        const state = clientRef.current.getConnectionState();
        setConnectionState(state);

        if (state === "connected") {
          retryCountRef.current = 0;
          setHasError(false);
        }

        if (state === "failed" || state === "disconnected") {
          setHasError(true);
          clearInterval(stateInterval);

          if (retryCountRef.current < 3) {
            retryCountRef.current++;
            const delay = retryCountRef.current * 3000;
            retryTimeoutRef.current = setTimeout(() => connect(), delay);
          }
        }
      }, 1000);

      return () => clearInterval(stateInterval);
    } catch (err) {
      console.error("[WebRTCPlayer] Failed to create WHEPClient:", err);
      setHasError(true);
      setConnectionState("failed");
    }
  }, [url]);

  useEffect(() => {
    retryCountRef.current = 0;
    connect();

    return () => {
      if (clientRef.current) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [connect]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleMuteToggle = () => {
    if (videoRef.current) {
      const newMuted = !muted;
      videoRef.current.muted = newMuted;
      onMutedChange?.(newMuted);
    }
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await containerRef.current.requestFullscreen();
      }
    } catch (err) {
      console.error("[WebRTCPlayer] Fullscreen error:", err);
    }
  };

  const MuteIcon = () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {muted ? (
        <>
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <>
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </>
      )}
    </svg>
  );

  const FullscreenIcon = () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {isFullscreen ? (
        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
      ) : (
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
      )}
    </svg>
  );

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="w-full h-full object-contain"
      />

      {/* Controls bar */}
      {connectionState === "connected" && (
        <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center gap-1 px-3 py-2 bg-gradient-to-t from-black/70 to-transparent">
          <button
            onClick={handleMuteToggle}
            className="w-8 h-8 flex items-center justify-center rounded-full border-none bg-transparent cursor-pointer text-white p-0"
            type="button"
          >
            <MuteIcon />
          </button>

          <div className="flex-1" />

          {showFullscreenButton && (
            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 flex items-center justify-center rounded-full border-none bg-transparent cursor-pointer text-white p-0"
              type="button"
            >
              <FullscreenIcon />
            </button>
          )}
        </div>
      )}

      {/* Connecting overlay */}
      {connectionState !== "connected" && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center">
            <div className="w-10 h-10 border-3 border-white border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-white text-sm m-0">Connecting to stream...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {hasError && retryCountRef.current >= 3 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center">
            <p className="text-white text-sm mb-3">Stream connection lost</p>
            <button
              onClick={() => {
                retryCountRef.current = 0;
                connect();
              }}
              className="px-4 py-2 bg-white/20 text-white border-none rounded-full text-sm cursor-pointer"
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
