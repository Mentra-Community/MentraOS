package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
)

// RoomSession manages a single user's LiveKit room connection
type RoomSession struct {
	userId           string
	room             *lksdk.Room
	publishTrack     *lkmedia.PCMLocalTrack // Deprecated: use tracks map
	tracks           map[string]*lkmedia.PCMLocalTrack
	publications     map[string]*lksdk.LocalTrackPublication // Track publications for unpublishing
	audioFromLiveKit chan []byte
	ctx              context.Context
	cancel           context.CancelFunc
	closeOnce        sync.Once
	playbackCancel   context.CancelFunc
	playbackDone     chan struct{} // Signals when playback actually stops
	mu               sync.RWMutex

	// Connectivity state (tracked for status RPC)
	connected            bool
	participantID        string
	participantCount     int
	lastDisconnectAt     time.Time
	lastDisconnectReason string

	// Logger for this session
	bsLogger *logger.BetterStackLogger
}

// NewRoomSession creates a new room session
func NewRoomSession(userId string, bsLogger *logger.BetterStackLogger) *RoomSession {
	ctx, cancel := context.WithCancel(context.Background())
	return &RoomSession{
		userId:           userId,
		tracks:           make(map[string]*lkmedia.PCMLocalTrack),
		publications:     make(map[string]*lksdk.LocalTrackPublication),
		audioFromLiveKit: make(chan []byte, 200), // Increased buffer for bursty audio
		ctx:              ctx,
		cancel:           cancel,
		bsLogger:         bsLogger,
	}
}

// createLogger creates a context logger for this session
func (s *RoomSession) createLogger(feature string) *logger.ContextLogger {
	return s.bsLogger.WithContext(logger.LogContext{
		UserID:  s.userId,
		Feature: feature,
	})
}

// createPublishTrack creates and publishes an audio track (deprecated, kept for compatibility)
func (s *RoomSession) createPublishTrack() (*lkmedia.PCMLocalTrack, error) {
	// Use "speaker" as default track name
	return s.getOrCreateTrack("speaker")
}

// getOrCreateTrack gets or creates a named audio track
func (s *RoomSession) getOrCreateTrack(trackName string) (*lkmedia.PCMLocalTrack, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	lg := s.createLogger("livekit-grpc")

	if s.room == nil {
		lg.Error("Cannot create track: room not connected", nil, logger.LogEntry{
			TrackName: trackName,
		})
		return nil, fmt.Errorf("room not connected")
	}

	// Default to "speaker" if not specified
	if trackName == "" {
		trackName = "speaker"
	}

	// Return existing track if already created
	if track, exists := s.tracks[trackName]; exists {
		lg.Debug("Reusing existing track", logger.LogEntry{
			TrackName: trackName,
		})
		return track, nil
	}

	lg.Info("Creating new PCM track", logger.LogEntry{
		TrackName: trackName,
		Extra: map[string]interface{}{
			"sample_rate": 16000,
			"channels":    1,
		},
	})

	// Create new PCM track (16kHz, mono)
	track, err := lkmedia.NewPCMLocalTrack(16000, 1, nil)
	if err != nil {
		lg.Error("Failed to create PCM track", err, logger.LogEntry{
			TrackName: trackName,
		})
		return nil, fmt.Errorf("failed to create PCM track: %w", err)
	}

	// Publish track to room with specified name
	lg.Debug("Publishing track to LiveKit room", logger.LogEntry{
		TrackName: trackName,
	})

	publication, err := s.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name: trackName,
	})
	if err != nil {
		track.Close()
		lg.Error("Failed to publish track to LiveKit", err, logger.LogEntry{
			TrackName: trackName,
		})
		return nil, fmt.Errorf("failed to publish track: %w", err)
	}

	s.tracks[trackName] = track
	s.publications[trackName] = publication

	// Allow WebRTC negotiation to complete before returning
	// This prevents audio loss on the first chunk (~100ms for SDP offer/answer)
	time.Sleep(100 * time.Millisecond)

	lg.Info("Track published successfully", logger.LogEntry{
		TrackName: trackName,
		Extra: map[string]interface{}{
			"track_sid":      publication.SID(),
			"webrtc_warm_ms": 100,
		},
	})

	log.Printf("Published PCM track '%s' for user %s (WebRTC warmed)", trackName, s.userId)
	return track, nil
}

// writeAudioToLiveKit writes PCM audio data to the LiveKit track
func (s *RoomSession) writeAudioToLiveKit(pcmData []byte) error {
	return s.writeAudioToTrack(pcmData, "speaker")
}

// writeAudioToTrack writes PCM audio data to a specific named track
func (s *RoomSession) writeAudioToTrack(pcmData []byte, trackName string) error {
	if trackName == "" {
		trackName = "speaker"
	}

	track, err := s.getOrCreateTrack(trackName)
	if err != nil {
		return err
	}

	// Ensure even-length PCM data
	if len(pcmData)%2 == 1 {
		pcmData = pcmData[:len(pcmData)-1]
	}

	if len(pcmData) == 0 {
		return nil
	}

	// Convert bytes to int16 samples
	samples := bytesToInt16(pcmData)

	// Write in 10ms chunks (160 samples at 16kHz)
	sampleRate := 16000
	frameSamples := sampleRate / 100 // 10ms chunks

	for offset := 0; offset < len(samples); offset += frameSamples {
		end := offset + frameSamples
		if end > len(samples) {
			end = len(samples)
		}

		frame := samples[offset:end]
		if err := track.WriteSample(frame); err != nil {
			lg := s.createLogger("livekit-grpc")
			lg.Error("Failed to write audio sample to track", err, logger.LogEntry{
				TrackName: trackName,
				Extra: map[string]interface{}{
					"frame_size":    len(frame),
					"total_samples": len(samples),
					"offset":        offset,
				},
			})
			return fmt.Errorf("failed to write sample: %w", err)
		}
	}

	return nil
}

// closeTrack closes and unpublishes a specific track
func (s *RoomSession) closeTrack(trackName string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	lg := s.createLogger("livekit-grpc")

	// First unpublish the track from LiveKit room
	if publication, exists := s.publications[trackName]; exists {
		if s.room != nil && s.room.LocalParticipant != nil {
			s.room.LocalParticipant.UnpublishTrack(publication.SID())
			lg.Info("Unpublished track from LiveKit", logger.LogEntry{
				TrackName: trackName,
				Extra: map[string]interface{}{
					"track_sid": publication.SID(),
				},
			})
			log.Printf("Unpublished track '%s' (SID: %s) for user %s", trackName, publication.SID(), s.userId)
		}
		delete(s.publications, trackName)
	}

	// Then close the track
	if track, exists := s.tracks[trackName]; exists {
		track.Close()
		delete(s.tracks, trackName)
		lg.Info("Closed track", logger.LogEntry{
			TrackName: trackName,
		})
		log.Printf("Closed track '%s' for user %s", trackName, s.userId)
	}
}

// stopPlayback cancels any ongoing audio playback and unpublishes all tracks to immediately stop audio
// Returns a channel that closes when the old playback has actually stopped
func (s *RoomSession) stopPlayback() <-chan struct{} {
	s.mu.Lock()

	lg := s.createLogger("livekit-grpc")
	lg.Info("Stopping all playback", logger.LogEntry{
		Extra: map[string]interface{}{
			"track_count":       len(s.tracks),
			"publication_count": len(s.publications),
		},
	})

	// Unpublish all tracks immediately to stop audio output
	// This ensures the currently playing audio is cut off right away
	if s.room != nil && s.room.LocalParticipant != nil {
		for trackName, publication := range s.publications {
			s.room.LocalParticipant.UnpublishTrack(publication.SID())
			lg.Debug("Unpublished track to interrupt audio", logger.LogEntry{
				TrackName: trackName,
				Extra: map[string]interface{}{
					"track_sid": publication.SID(),
				},
			})
			log.Printf("Unpublished track '%s' (SID: %s) to interrupt audio for user %s", trackName, publication.SID(), s.userId)
		}
		// Clear publications map - tracks will be recreated on next playback
		s.publications = make(map[string]*lksdk.LocalTrackPublication)
	}

	// Close all tracks to clean up resources
	for trackName, track := range s.tracks {
		track.Close()
		lg.Debug("Closed track to interrupt audio", logger.LogEntry{
			TrackName: trackName,
		})
		log.Printf("Closed track '%s' to interrupt audio for user %s", trackName, s.userId)
	}
	// Clear tracks map - tracks will be recreated on next playback
	s.tracks = make(map[string]*lkmedia.PCMLocalTrack)

	// If no playback is running, return closed channel immediately
	if s.playbackCancel == nil {
		s.mu.Unlock()
		done := make(chan struct{})
		close(done)
		return done
	}

	// Cancel the current playback
	s.playbackCancel()
	s.playbackCancel = nil

	// Return the done channel so caller can wait for completion
	done := s.playbackDone
	s.mu.Unlock()

	lg.Info("Playback stop initiated", logger.LogEntry{})

	return done
}

// stopTrackPlayback stops playback on a specific track only (for audio mixing)
// This allows other tracks to continue playing
func (s *RoomSession) stopTrackPlayback(trackName string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	lg := s.createLogger("livekit-grpc")
	lg.Info("Stopping track playback (mixing mode)", logger.LogEntry{
		TrackName: trackName,
	})

	// Unpublish this specific track immediately to stop its audio output
	if s.room != nil && s.room.LocalParticipant != nil {
		if publication, exists := s.publications[trackName]; exists {
			s.room.LocalParticipant.UnpublishTrack(publication.SID())
			lg.Debug("Unpublished track for mixing mode", logger.LogEntry{
				TrackName: trackName,
				Extra: map[string]interface{}{
					"track_sid": publication.SID(),
				},
			})
			log.Printf("Unpublished track '%s' (SID: %s) for mixing mode, user %s", trackName, publication.SID(), s.userId)
			delete(s.publications, trackName)
		}
	}

	// Close this specific track to clean up resources
	if track, exists := s.tracks[trackName]; exists {
		track.Close()
		lg.Debug("Closed track for mixing mode", logger.LogEntry{
			TrackName: trackName,
		})
		log.Printf("Closed track '%s' for mixing mode, user %s", trackName, s.userId)
		delete(s.tracks, trackName)
	}
}

// Close cleans up all resources
func (s *RoomSession) Close() {
	s.closeOnce.Do(func() {
		lg := s.createLogger("livekit-grpc")
		lg.Info("Closing room session", logger.LogEntry{
			Extra: map[string]interface{}{
				"track_count":       len(s.tracks),
				"publication_count": len(s.publications),
			},
		})
		log.Printf("Closing room session for user %s", s.userId)

		// Cancel context (stops all goroutines)
		s.cancel()

		// Stop any playback
		s.stopPlayback()

		s.mu.Lock()
		defer s.mu.Unlock()

		// Unpublish all tracks first
		if s.room != nil && s.room.LocalParticipant != nil {
			for name, publication := range s.publications {
				s.room.LocalParticipant.UnpublishTrack(publication.SID())
				lg.Debug("Unpublished track during session close", logger.LogEntry{
					TrackName: name,
				})
				log.Printf("Unpublished track '%s' for user %s", name, s.userId)
			}
		}
		s.publications = make(map[string]*lksdk.LocalTrackPublication)

		// Close all tracks
		for name, track := range s.tracks {
			track.Close()
			lg.Debug("Closed track during session close", logger.LogEntry{
				TrackName: name,
			})
			log.Printf("Closed track '%s' for user %s", name, s.userId)
		}
		s.tracks = make(map[string]*lkmedia.PCMLocalTrack)

		// Close deprecated single track if still present
		if s.publishTrack != nil {
			s.publishTrack.Close()
			s.publishTrack = nil
		}

		// Disconnect from room
		if s.room != nil {
			s.room.Disconnect()
			s.room = nil
		}

		// Update connectivity state
		s.connected = false
		s.lastDisconnectAt = time.Now()
		s.lastDisconnectReason = "closed"

		// Close audio channel
		close(s.audioFromLiveKit)

		lg.Info("Room session closed successfully", logger.LogEntry{})
		log.Printf("Closed room session for user %s", s.userId)
	})
}

// bytesToInt16 converts byte slice to int16 samples (little-endian)
func bytesToInt16(pcmData []byte) []int16 {
	if len(pcmData)%2 == 1 {
		pcmData = pcmData[:len(pcmData)-1]
	}

	samples := make([]int16, len(pcmData)/2)
	for i := 0; i < len(samples); i++ {
		samples[i] = int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
	}

	return samples
}

// int16ToBytes converts int16 samples to byte slice (little-endian)
func int16ToBytes(samples []int16) []byte {
	pcmData := make([]byte, len(samples)*2)
	for i, sample := range samples {
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(sample))
	}
	return pcmData
}
