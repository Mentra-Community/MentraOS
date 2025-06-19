import { useRef, useEffect, useCallback } from 'react';

interface AudioRecordingOptions {
  onAudioData: (data: ArrayBuffer) => void;
  isRecording: boolean;
  sampleRate?: number;
}

export const useAudioRecording = ({
  onAudioData,
  isRecording,
  sampleRate = 16000
}: AudioRecordingOptions) => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Buffer queue for batching audio chunks
  const audioBufferQueue = useRef<ArrayBuffer[]>([]);

  // Initialize AudioContext
  useEffect(() => {
    audioContextRef.current = new AudioContext({ sampleRate });
    
    return () => {
      audioContextRef.current?.close();
    };
  }, [sampleRate]);



  // Set up audio processing
  const setupAudioProcessing = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate });
    }

    try {
      // Load audio worklet
      await audioContextRef.current.audioWorklet.addModule('/audio-processor.js');
      
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      // Create and connect nodes
      const sourceNode = audioContextRef.current.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      
      const workletNode = new AudioWorkletNode(audioContextRef.current, 'audio-processor');
      workletNodeRef.current = workletNode;
      
      // Handle audio data from worklet
      workletNode.port.onmessage = (event) => {
        audioBufferQueue.current.push(event.data);
      };
      
      // Connect nodes
      sourceNode.connect(workletNode);
      workletNode.connect(audioContextRef.current.destination);
      
      // Resume AudioContext if needed
      if (audioContextRef.current.state !== 'running') {
        await audioContextRef.current.resume();
      }
    } catch (error) {
      console.error('Error setting up audio processing:', error);
      throw error;
    }
  }, []);

  // Clean up audio processing
  const cleanupAudioProcessing = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    audioBufferQueue.current = [];
  }, []);

  // Set up interval to process audio buffer queue
  useEffect(() => {
    if (!isRecording) return;

    const interval = setInterval(() => {
      if (audioBufferQueue.current.length > 0) {
        // Merge all buffers in the queue
        const buffersToSend = audioBufferQueue.current.splice(0);
        const totalLength = buffersToSend.reduce(
          (sum, buffer) => sum + buffer.byteLength,
          0
        );
        
        const mergedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        
        for (const buffer of buffersToSend) {
          mergedBuffer.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        }
        
        onAudioData(mergedBuffer.buffer);
      }
    }, 150);

    return () => clearInterval(interval);
  }, [isRecording, onAudioData]);

  // Handle recording state changes
  useEffect(() => {
    if (isRecording) {
      setupAudioProcessing().catch(console.error);
    } else {
      cleanupAudioProcessing();
    }
    
    return () => {
      cleanupAudioProcessing();
    };
  }, [isRecording, setupAudioProcessing, cleanupAudioProcessing]);

  return {
    isProcessing: !!workletNodeRef.current,
    hasError: false, // TODO: Implement error handling
  };
};