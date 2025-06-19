import React, { useCallback } from 'react';
import { useAudioRecording } from '../hooks/useAudioRecording';

interface AudioManagerProps {
  isRecording: boolean;
  sessionId: string | null;
  onError?: (error: Error) => void;
  websocket: WebSocket | null;
}

export const AudioManager: React.FC<AudioManagerProps> = ({
  isRecording,
  sessionId,
  onError,
  websocket
}) => {
  // Handle audio data from the recording hook
  const handleAudioData = useCallback((audioData: ArrayBuffer) => {
    if (websocket?.readyState === 1) {
      websocket.send(audioData);
    }
  }, [websocket]);

  // Use the audio recording hook
  const { isProcessing, hasError } = useAudioRecording({
    onAudioData: handleAudioData,
    isRecording: isRecording && !!sessionId && !!websocket,
  });

  // Optionally render status indicators
  return (
    <div className="flex items-center gap-2">
      {isRecording && (
        <>
          <div className={`w-2 h-2 rounded-full ${
            isProcessing 
              ? 'bg-green-500 animate-pulse'
              : hasError
                ? 'bg-red-500'
                : 'bg-yellow-500'
          }`} />
          Audio
          <span className="text-xs text-gray-400">
            {isProcessing 
              ? '🚀 Transmitting...'
              : hasError
                ? '🥲 Error'
                : '😴 Waiting...'}
          </span>
        </>
      )}
    </div>
  );
};