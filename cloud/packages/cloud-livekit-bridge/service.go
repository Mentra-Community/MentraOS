package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/logger"
	pb "github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/proto"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// trackIDToName converts track ID to track name
func trackIDToName(trackID int32) string {
	switch trackID {
	case 0:
		return "speaker"
	case 1:
		return "app_audio"
	case 2:
		return "tts"
	default:
		return fmt.Sprintf("track_%d", trackID)
	}
}

// LiveKitBridgeService implements the gRPC service
type LiveKitBridgeService struct {
	pb.UnimplementedLiveKitBridgeServer

	sessions sync.Map // userId -> *RoomSession
	config   *Config
	bsLogger *logger.BetterStackLogger
	mu       sync.RWMutex
}

// NewLiveKitBridgeService creates a new service instance
func NewLiveKitBridgeService(config *Config, bsLogger *logger.BetterStackLogger) *LiveKitBridgeService {
	return &LiveKitBridgeService{
		config:   config,
		bsLogger: bsLogger,
	}
}

// createLogger creates a context logger for a user
func (s *LiveKitBridgeService) createLogger(userId, roomName, feature string) *logger.ContextLogger {
	return s.bsLogger.WithContext(logger.LogContext{
		UserID:   userId,
		RoomName: roomName,
		Feature:  feature,
	})
}

// JoinRoom handles room join requests
func (s *LiveKitBridgeService) JoinRoom(
	ctx context.Context,
	req *pb.JoinRoomRequest,
) (*pb.JoinRoomResponse, error) {
	lg := s.createLogger(req.UserId, req.RoomName, "livekit-grpc")

	log.Printf("JoinRoom request: userId=%s, room=%s", req.UserId, req.RoomName)
	lg.Info("JoinRoom request received", logger.LogEntry{
		LiveKitURL:     req.LivekitUrl,
		TargetIdentity: req.TargetIdentity,
	})

	// Always replace existing session if present (handles reconnections, crashes, zombie sessions)
	if existingVal, exists := s.sessions.Load(req.UserId); exists {
		lg.Info("Replacing existing bridge session", logger.LogEntry{
			Extra: map[string]interface{}{
				"reason": "new_join_request",
			},
		})

		existingSession := existingVal.(*RoomSession)
		existingSession.Close() // Calls room.Disconnect(), closes goroutines
		s.sessions.Delete(req.UserId)
	}

	// Create new session
	session := NewRoomSession(req.UserId, s.bsLogger)

	// Setup callbacks for LiveKit room
	var receivedPackets int64
	var droppedPackets int64
	var lastPacketTime = time.Now()

	roomCallback := &lksdk.RoomCallback{
		OnParticipantConnected: func(p *lksdk.RemoteParticipant) {
			log.Printf("Participant connected to room %s: identity=%s, sid=%s",
				req.RoomName, p.Identity(), p.SID())
			lg.Info("Participant connected", logger.LogEntry{
				Extra: map[string]interface{}{
					"participant_identity": string(p.Identity()),
					"participant_sid":      string(p.SID()),
				},
			})
		},
		OnParticipantDisconnected: func(p *lksdk.RemoteParticipant) {
			log.Printf("Participant disconnected from room %s: identity=%s, sid=%s",
				req.RoomName, p.Identity(), p.SID())
			lg.Info("Participant disconnected", logger.LogEntry{
				Extra: map[string]interface{}{
					"participant_identity": string(p.Identity()),
					"participant_sid":      string(p.SID()),
				},
			})
		},
		OnReconnecting: func() {
			log.Printf("Room %s is reconnecting for user %s", req.RoomName, req.UserId)
			lg.Warn("LiveKit room is reconnecting", logger.LogEntry{})
		},
		OnReconnected: func() {
			log.Printf("Room %s reconnected for user %s", req.RoomName, req.UserId)
			lg.Info("LiveKit room reconnected", logger.LogEntry{})
		},
		ParticipantCallback: lksdk.ParticipantCallback{
			OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
				// Only process packets from target identity if specified
				if req.TargetIdentity != "" && params.SenderIdentity != req.TargetIdentity {
					return
				}

				// Extract audio data from packet
				userPacket, ok := packet.(*lksdk.UserDataPacket)
				if !ok || len(userPacket.Payload) == 0 {
					return
				}

				receivedPackets++
				now := time.Now()
				gapMs := now.Sub(lastPacketTime).Milliseconds()
				lastPacketTime = now

				// Log first 10 packets and then every 100 to catch early flow issues
				// Also log if there was a gap > 500ms between packets
				if receivedPackets <= 10 || receivedPackets%100 == 0 || gapMs > 500 {
					log.Printf("OnDataPacket for %s: packet #%d, sender=%s, size=%d bytes, gapMs=%d",
						req.UserId, receivedPackets, params.SenderIdentity, len(userPacket.Payload), gapMs)
				}

				// Match old bridge behavior exactly
				pcmData := userPacket.Payload
				if len(pcmData)%2 == 1 {
					pcmData = pcmData[1:]
				}
				if len(pcmData)%2 == 1 {
					pcmData = pcmData[:len(pcmData)-1]
				}
				if len(pcmData) == 0 {
					return
				}

				// Send to channel (non-blocking)
				select {
				case session.audioFromLiveKit <- pcmData:
					// Log periodically to show audio is flowing
					if receivedPackets%100 == 0 {
						lg.Debug("Audio flowing from LiveKit", logger.LogEntry{
							ReceivedPackets: receivedPackets,
							DroppedPackets:  droppedPackets,
							ChannelLen:      len(session.audioFromLiveKit),
						})
						log.Printf("Audio flowing for %s: received=%d, dropped=%d, channelLen=%d",
							req.UserId, receivedPackets, droppedPackets, len(session.audioFromLiveKit))
					}
				default:
					// Drop frame if channel full (backpressure)
					droppedPackets++
					if droppedPackets%50 == 0 {
						lg.Warn("Dropping audio frames due to backpressure", logger.LogEntry{
							DroppedPackets: droppedPackets,
							ChannelLen:     len(session.audioFromLiveKit),
						})
						log.Printf("Dropping audio frames for %s: total_dropped=%d, channel_full=%d",
							req.UserId, droppedPackets, len(session.audioFromLiveKit))
					}
				}
			},
		},
		OnDisconnected: func() {
			log.Printf("Disconnected from LiveKit room: %s", req.RoomName)
			lg.Warn("Disconnected from LiveKit room", logger.LogEntry{
				Extra: map[string]interface{}{
					"disconnect_reason": "livekit_disconnect_callback",
				},
			})

			// Mark session as disconnected for status RPC
			if sessVal, ok := s.sessions.Load(req.UserId); ok {
				session := sessVal.(*RoomSession)
				session.mu.Lock()
				session.connected = false
				session.lastDisconnectAt = time.Now()
				if session.lastDisconnectReason == "" {
					session.lastDisconnectReason = "disconnected"
				}
				session.mu.Unlock()
			}
		},
	}

	// Connect to LiveKit room
	room, err := lksdk.ConnectToRoomWithToken(
		req.LivekitUrl,
		req.Token,
		roomCallback,
		lksdk.WithAutoSubscribe(false),
	)
	if err != nil {
		lg.Error("Failed to connect to LiveKit room", err, logger.LogEntry{
			LiveKitURL: req.LivekitUrl,
		})
		return &pb.JoinRoomResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to connect to room: %v", err),
		}, nil
	}

	session.room = room

	// Update connectivity state for status RPC
	session.mu.Lock()
	session.connected = true
	session.participantID = string(room.LocalParticipant.Identity())
	session.participantCount = len(room.GetRemoteParticipants()) + 1
	session.lastDisconnectReason = "" // clear previous reason on fresh join
	session.mu.Unlock()

	// DON'T create track here - only create when actually playing audio
	// This prevents static feedback loop (mobile hears empty track as static)

	// Store session
	s.sessions.Store(req.UserId, session)

	log.Printf("Successfully joined room: userId=%s, participantId=%s",
		req.UserId, room.LocalParticipant.Identity())

	lg.Info("Successfully joined LiveKit room", logger.LogEntry{
		ParticipantID:    string(room.LocalParticipant.Identity()),
		ParticipantCount: len(room.GetRemoteParticipants()) + 1,
	})

	return &pb.JoinRoomResponse{
		Success:          true,
		ParticipantId:    string(room.LocalParticipant.Identity()),
		ParticipantCount: int32(len(room.GetRemoteParticipants())) + 1,
	}, nil
}

// LeaveRoom handles room leave requests
func (s *LiveKitBridgeService) LeaveRoom(
	ctx context.Context,
	req *pb.LeaveRoomRequest,
) (*pb.LeaveRoomResponse, error) {
	lg := s.createLogger(req.UserId, "", "livekit-grpc")

	log.Printf("LeaveRoom request: userId=%s", req.UserId)
	lg.Info("LeaveRoom request received", logger.LogEntry{})

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		lg.Warn("LeaveRoom: session not found", logger.LogEntry{})
		return &pb.LeaveRoomResponse{
			Success: false,
			Error:   "session not found",
		}, nil
	}

	session := sessionVal.(*RoomSession)
	session.Close()
	s.sessions.Delete(req.UserId)

	lg.Info("LeaveRoom completed successfully", logger.LogEntry{})

	return &pb.LeaveRoomResponse{
		Success: true,
	}, nil
}

// StreamAudio handles bidirectional audio streaming
func (s *LiveKitBridgeService) StreamAudio(
	stream pb.LiveKitBridge_StreamAudioServer,
) error {
	// First message should contain connection info
	firstMsg, err := stream.Recv()
	if err != nil {
		s.bsLogger.LogError("StreamAudio: failed to receive first message", err, nil)
		return status.Errorf(codes.InvalidArgument, "failed to receive first message: %v", err)
	}

	userId := firstMsg.UserId
	lg := s.createLogger(userId, "", "livekit-grpc")

	lg.Info("StreamAudio started", logger.LogEntry{})
	log.Printf("StreamAudio started for userId=%s", userId)

	sessionVal, ok := s.sessions.Load(userId)
	if !ok {
		lg.Error("StreamAudio: session not found", nil, logger.LogEntry{})
		return status.Errorf(codes.NotFound, "session not found for user %s", userId)
	}
	session := sessionVal.(*RoomSession)

	// Start goroutine to send audio FROM LiveKit TO client
	go func() {
		for {
			select {
			case pcmData, ok := <-session.audioFromLiveKit:
				if !ok {
					lg.Debug("StreamAudio: audio channel closed", logger.LogEntry{})
					return
				}
				if err := stream.Send(&pb.AudioChunk{
					PcmData:     pcmData,
					SampleRate:  16000,
					Channels:    1,
					TimestampMs: time.Now().UnixMilli(),
				}); err != nil {
					lg.Error("StreamAudio: failed to send audio chunk", err, logger.LogEntry{})
					return
				}
			case <-session.ctx.Done():
				lg.Debug("StreamAudio: session context cancelled", logger.LogEntry{})
				return
			}
		}
	}()

	// Receive audio FROM client (currently unused but keeps stream open)
	for {
		_, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				lg.Info("StreamAudio: client closed stream", logger.LogEntry{})
				return nil
			}
			lg.Error("StreamAudio error", err, logger.LogEntry{})
			log.Printf("StreamAudio error for %s: %v", userId, err)

			// Clean up session on error
			lg.Warn("Cleaning up session due to stream error", logger.LogEntry{})
			session.Close()
			s.sessions.Delete(userId)

			return err
		}
	}
}

// PlayAudio handles playing audio from a URL to the LiveKit room
func (s *LiveKitBridgeService) PlayAudio(
	req *pb.PlayAudioRequest,
	stream pb.LiveKitBridge_PlayAudioServer,
) error {
	trackName := trackIDToName(req.TrackId)

	lg := s.bsLogger.WithContext(logger.LogContext{
		UserID:    req.UserId,
		RequestID: req.RequestId,
		TrackID:   req.TrackId,
		TrackName: trackName,
		Feature:   "livekit-grpc",
	})

	log.Printf("PlayAudio request: userId=%s, url=%s, requestId=%s, trackId=%d",
		req.UserId, req.AudioUrl, req.RequestId, req.TrackId)

	lg.Info("PlayAudio request received", logger.LogEntry{
		AudioURL: req.AudioUrl,
		Extra: map[string]interface{}{
			"volume":     req.Volume,
			"stop_other": req.StopOther,
		},
	})

	// Validate URL
	if req.AudioUrl == "" {
		lg.Error("PlayAudio: empty audio URL", nil, logger.LogEntry{})
		stream.Send(&pb.PlayAudioEvent{
			Type:      pb.PlayAudioEvent_FAILED,
			RequestId: req.RequestId,
			Error:     "audio URL is empty",
		})
		return status.Errorf(codes.InvalidArgument, "audio URL is empty")
	}

	// Check for invalid URL schemes
	if req.AudioUrl == "nothing" || (!hasValidScheme(req.AudioUrl)) {
		err := fmt.Errorf("invalid audio URL: %s (must start with http:// or https://)", req.AudioUrl)
		lg.Error("PlayAudio: invalid audio URL scheme", err, logger.LogEntry{
			AudioURL: req.AudioUrl,
		})
		stream.Send(&pb.PlayAudioEvent{
			Type:      pb.PlayAudioEvent_FAILED,
			RequestId: req.RequestId,
			Error:     err.Error(),
		})
		return status.Errorf(codes.InvalidArgument, "%s", err.Error())
	}

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		lg.Error("PlayAudio: session not found", nil, logger.LogEntry{})
		stream.Send(&pb.PlayAudioEvent{
			Type:      pb.PlayAudioEvent_FAILED,
			RequestId: req.RequestId,
			Error:     fmt.Sprintf("session not found for user %s", req.UserId),
		})
		return status.Errorf(codes.NotFound, "session not found for user %s", req.UserId)
	}
	session := sessionVal.(*RoomSession)

	// Check if room is connected
	session.mu.RLock()
	isConnected := session.connected
	session.mu.RUnlock()

	if !isConnected {
		lg.Error("PlayAudio: LiveKit room not connected", nil, logger.LogEntry{
			Extra: map[string]interface{}{
				"session_state": "disconnected",
			},
		})
		stream.Send(&pb.PlayAudioEvent{
			Type:      pb.PlayAudioEvent_FAILED,
			RequestId: req.RequestId,
			Error:     "LiveKit room not connected",
		})
		return status.Errorf(codes.FailedPrecondition, "LiveKit room not connected for user %s", req.UserId)
	}

	// Handle stopping logic based on StopOther flag
	if req.StopOther {
		// StopOther=true: Stop ALL tracks (interrupt mode)
		log.Printf("StopOther flag set, stopping ALL tracks for user %s", req.UserId)
		lg.Debug("Stopping all tracks (interrupt mode)", logger.LogEntry{})
		session.stopPlayback()
	} else {
		// StopOther=false: Only stop THIS specific track to avoid conflicts (mixing mode)
		log.Printf("Audio mixing mode: stopping only track '%s' for user %s", trackName, req.UserId)
		lg.Debug("Stopping single track (mixing mode)", logger.LogEntry{})
		session.stopTrackPlayback(trackName)
	}

	// Send STARTED event
	lg.Debug("Sending STARTED event", logger.LogEntry{})
	if err := stream.Send(&pb.PlayAudioEvent{
		Type:      pb.PlayAudioEvent_STARTED,
		RequestId: req.RequestId,
	}); err != nil {
		lg.Error("Failed to send STARTED event", err, logger.LogEntry{})
		return err
	}

	// Play audio file synchronously - MUST wait to keep gRPC stream open
	lg.Info("Starting audio playback", logger.LogEntry{
		AudioURL: req.AudioUrl,
	})

	startTime := time.Now()
	duration, err := s.playAudioFile(req, session, stream, trackName, lg)
	playbackDuration := time.Since(startTime)

	if err != nil {
		lg.Error("PlayAudio playback failed", err, logger.LogEntry{
			AudioURL:   req.AudioUrl,
			DurationMs: playbackDuration.Milliseconds(),
		})

		// Send FAILED event
		stream.Send(&pb.PlayAudioEvent{
			Type:      pb.PlayAudioEvent_FAILED,
			RequestId: req.RequestId,
			Error:     err.Error(),
		})

		// Close only this specific track on error
		session.closeTrack(trackName)
		return err
	}

	// Send COMPLETED event
	lg.Info("PlayAudio completed successfully", logger.LogEntry{
		AudioURL:   req.AudioUrl,
		DurationMs: duration,
		Extra: map[string]interface{}{
			"actual_playback_ms": playbackDuration.Milliseconds(),
		},
	})

	if err := stream.Send(&pb.PlayAudioEvent{
		Type:       pb.PlayAudioEvent_COMPLETED,
		RequestId:  req.RequestId,
		DurationMs: duration,
	}); err != nil {
		lg.Error("Failed to send COMPLETED event", err, logger.LogEntry{})
		return err
	}

	// DON'T close the track after playback - keep it alive for reuse
	log.Printf("Playback completed for track '%s', keeping track alive for reuse", trackName)

	return nil
}

// hasValidScheme checks if URL has a valid HTTP(S) scheme
func hasValidScheme(url string) bool {
	return len(url) > 7 && (url[:7] == "http://" || url[:8] == "https://")
}

// StopAudio handles stopping audio playback
func (s *LiveKitBridgeService) StopAudio(
	ctx context.Context,
	req *pb.StopAudioRequest,
) (*pb.StopAudioResponse, error) {
	trackName := trackIDToName(req.TrackId)
	lg := s.bsLogger.WithContext(logger.LogContext{
		UserID:    req.UserId,
		TrackID:   req.TrackId,
		TrackName: trackName,
		Feature:   "livekit-grpc",
	})

	log.Printf("StopAudio request: userId=%s, trackId=%d", req.UserId, req.TrackId)
	lg.Info("StopAudio request received", logger.LogEntry{})

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		lg.Warn("StopAudio: session not found", logger.LogEntry{})
		return &pb.StopAudioResponse{
			Success: false,
			Error:   "session not found",
		}, nil
	}

	session := sessionVal.(*RoomSession)

	if req.TrackId == -1 {
		// Stop all playback
		lg.Info("Stopping all audio playback", logger.LogEntry{})
		session.stopPlayback()
	} else {
		// Stop specific track
		lg.Info("Stopping specific track", logger.LogEntry{})
		session.stopTrackPlayback(trackName)
	}

	lg.Info("StopAudio completed successfully", logger.LogEntry{})

	return &pb.StopAudioResponse{
		Success: true,
	}, nil
}

// HealthCheck handles health check requests
func (s *LiveKitBridgeService) HealthCheck(
	ctx context.Context,
	req *pb.HealthCheckRequest,
) (*pb.HealthCheckResponse, error) {
	var activeSessions int32
	var activeStreams int32

	s.sessions.Range(func(key, value interface{}) bool {
		activeSessions++
		session := value.(*RoomSession)
		if session.room != nil {
			activeStreams++
		}
		return true
	})

	s.bsLogger.LogDebug("HealthCheck called", map[string]interface{}{
		"feature":         "livekit-grpc",
		"active_sessions": activeSessions,
		"active_streams":  activeStreams,
	})

	return &pb.HealthCheckResponse{
		Status:         pb.HealthCheckResponse_SERVING,
		ActiveSessions: activeSessions,
		ActiveStreams:  activeStreams,
		UptimeSeconds:  0, // Could track uptime if needed
	}, nil
}

// getSession retrieves a session by user ID
func (s *LiveKitBridgeService) getSession(userId string) (*RoomSession, bool) {
	sessionVal, ok := s.sessions.Load(userId)
	if !ok {
		return nil, false
	}
	return sessionVal.(*RoomSession), true
}

// GetStatus returns the current status of a user's session
func (s *LiveKitBridgeService) GetStatus(
	ctx context.Context,
	req *pb.BridgeStatusRequest,
) (*pb.BridgeStatusResponse, error) {
	lg := s.createLogger(req.UserId, "", "livekit-grpc")
	lg.Debug("GetStatus request received", logger.LogEntry{})

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		lg.Debug("GetStatus: session not found", logger.LogEntry{})
		return &pb.BridgeStatusResponse{
			Connected: false,
		}, nil
	}

	session := sessionVal.(*RoomSession)
	session.mu.RLock()
	defer session.mu.RUnlock()

	// Count active tracks
	trackCount := len(session.tracks)

	// Convert disconnect time to milliseconds
	var lastDisconnectAtMs int64
	if !session.lastDisconnectAt.IsZero() {
		lastDisconnectAtMs = session.lastDisconnectAt.UnixMilli()
	}

	lg.Debug("GetStatus response", logger.LogEntry{
		ParticipantID:    session.participantID,
		ParticipantCount: session.participantCount,
		Extra: map[string]interface{}{
			"connected":              session.connected,
			"track_count":            trackCount,
			"last_disconnect_reason": session.lastDisconnectReason,
			"last_disconnect_at_ms":  lastDisconnectAtMs,
		},
	})

	return &pb.BridgeStatusResponse{
		Connected:            session.connected,
		ParticipantId:        session.participantID,
		ParticipantCount:     int32(session.participantCount),
		LastDisconnectAt:     lastDisconnectAtMs,
		LastDisconnectReason: session.lastDisconnectReason,
		ServerVersion:        "1.0.0",
	}, nil
}
