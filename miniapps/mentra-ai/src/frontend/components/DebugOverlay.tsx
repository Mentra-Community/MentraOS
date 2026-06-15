import { useState, useEffect, useRef, useCallback } from 'react';
import { useMentraAuth } from '@mentra/react';
import { withAuthSseUrl } from '../lib/authFetch';
import { TtsTestButton } from '../pages/home/components/TtsTestButton';
import { WakeGlowButton } from '../pages/home/components/WakeGlowButton';
import { SoundTestButtons } from '../pages/home/components/SoundTestButtons';

interface TranscriptionEntry {
  id: number;
  text: string;
  isFinal: boolean;
  timestamp: string;
}

interface DebugOverlayProps {
  onClose: () => void;
}

type DebugTab = 'transcription' | 'buttons';

export function DebugOverlay({ onClose }: DebugOverlayProps) {
  const { frontendToken } = useMentraAuth();
  const [entries, setEntries] = useState<TranscriptionEntry[]>([]);
  const [tab, setTab] = useState<DebugTab>('transcription');
  // Action log for the Buttons tab — newest first.
  const [actionLog, setActionLog] = useState<{ id: number; text: string; time: string }[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idCounterRef = useRef(0);
  const actionIdRef = useRef(0);
  const listEndRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [position, setPosition] = useState({ x: 16, y: window.innerHeight - 320 });
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Append a line to the Buttons-tab action log.
  const addActionLog = useCallback((text: string) => {
    setActionLog(prev =>
      [
        {
          id: actionIdRef.current++,
          text,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        },
        ...prev,
      ].slice(0, 30),
    );
  }, []);

  // Auto-scroll transcription list to bottom when new entries arrive
  useEffect(() => {
    if (tab === 'transcription') {
      listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, tab]);

  // SSE connection. Wait for the frontend token; otherwise the stream
  // 401s and triggers an unauthenticated reconnect loop.
  useEffect(() => {
    if (!frontendToken) return;

    const connect = () => {
      const es = new EventSource(
        withAuthSseUrl('/api/transcription-stream', frontendToken),
      );
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') return;

          const entry: TranscriptionEntry = {
            id: idCounterRef.current++,
            text: data.text,
            isFinal: data.isFinal ?? false,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          };

          setEntries(prev => {
            // If partial (not final), replace the last partial entry
            if (!entry.isFinal) {
              if (prev.length > 0 && !prev[prev.length - 1].isFinal) {
                const updated = [...prev];
                updated[updated.length - 1] = entry;
                return updated;
              }
              return [...prev, entry];
            }
            // If final, replace the last partial or append
            if (prev.length > 0 && !prev[prev.length - 1].isFinal) {
              const updated = [...prev];
              updated[updated.length - 1] = entry;
              return updated;
            }
            return [...prev, entry];
          });
        } catch {}
      };

      es.onerror = () => {
        es.close();
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [frontendToken]);

  // ── Drag handlers (shared by touch + mouse) ───────────────────────
  const beginDrag = useCallback((clientX: number, clientY: number) => {
    dragRef.current = {
      startX: clientX,
      startY: clientY,
      startPosX: position.x,
      startPosY: position.y,
    };
  }, [position]);

  const moveDrag = useCallback((clientX: number, clientY: number) => {
    if (!dragRef.current) return;
    const dx = clientX - dragRef.current.startX;
    const dy = clientY - dragRef.current.startY;

    // Clamp to viewport
    const maxX = window.innerWidth - (panelRef.current?.offsetWidth ?? 200);
    const maxY = window.innerHeight - (panelRef.current?.offsetHeight ?? 200);
    setPosition({
      x: Math.max(0, Math.min(dragRef.current.startPosX + dx, maxX)),
      y: Math.max(0, Math.min(dragRef.current.startPosY + dy, maxY)),
    });
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Touch
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    beginDrag(t.clientX, t.clientY);
  }, [beginDrag]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
  }, [moveDrag]);

  // Mouse — listeners attach to window so drag continues outside the handle.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    beginDrag(e.clientX, e.clientY);
    const onMove = (ev: MouseEvent) => moveDrag(ev.clientX, ev.clientY);
    const onUp = () => {
      endDrag();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [beginDrag, moveDrag, endDrag]);

  const tabBtn = (id: DebugTab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`flex-1 text-[10px] font-medium uppercase tracking-wider py-1 transition-colors ${
        tab === id
          ? 'text-white border-b-2 border-white/70'
          : 'text-white/35 border-b-2 border-transparent active:text-white/60'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={panelRef}
      style={{ left: position.x, top: position.y }}
      className="fixed z-[60] w-[280px] max-h-[280px] flex flex-col rounded-xl bg-black/80 backdrop-blur-md border border-white/10 shadow-2xl overflow-hidden"
    >
      {/* Drag handle + close */}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 cursor-grab active:cursor-grabbing select-none"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={endDrag}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10px]">🛠️</span>
          <span className="text-[10px] text-white/50 font-medium uppercase tracking-wider">Debug</span>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 active:text-white/80 hover:text-white/80 text-[14px] px-1"
        >
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-white/10">
        {tabBtn('transcription', 'Transcription')}
        {tabBtn('buttons', 'Buttons')}
      </div>

      {/* ── Transcription tab ── */}
      {tab === 'transcription' && (
        <div
          className="flex-1 overflow-y-auto px-2 py-1.5"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {entries.length === 0 && (
            <p className="text-[11px] text-white/30 text-center py-2">Listening...</p>
          )}
          {entries.map(entry => (
            <div key={entry.id} className="flex gap-1.5 py-0.5">
              <span className="text-[9px] text-white/25 font-mono flex-shrink-0 mt-[2px]">
                {entry.timestamp}
              </span>
              <span
                className={`text-[11px] font-mono break-all ${
                  entry.isFinal ? 'text-green-400' : 'text-white/60'
                }`}
              >
                {entry.text}
              </span>
            </div>
          ))}
          <div ref={listEndRef} />
        </div>
      )}

      {/* ── Buttons tab ── */}
      {tab === 'buttons' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Trigger buttons */}
          <div className="p-2.5 flex flex-col gap-2 border-b border-white/10">
            <TtsTestButton onLog={addActionLog} />
            <WakeGlowButton onLog={addActionLog} />
            <SoundTestButtons onLog={addActionLog} />
          </div>
          {/* Action log */}
          <div
            className="flex-1 overflow-y-auto px-2 py-1.5"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {actionLog.length === 0 && (
              <p className="text-[11px] text-white/30 text-center py-2">
                Tap a button to test it.
              </p>
            )}
            {actionLog.map(line => (
              <div key={line.id} className="flex gap-1.5 py-0.5">
                <span className="text-[9px] text-white/25 font-mono flex-shrink-0 mt-[2px]">
                  {line.time}
                </span>
                <span className="text-[11px] font-mono text-white/70 break-all">
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
