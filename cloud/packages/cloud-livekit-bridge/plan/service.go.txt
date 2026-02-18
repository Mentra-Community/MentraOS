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

// JoinRoom handles room join requests
func (s *LiveKitBridgeService) JoinRoom(
	ctx context.Context,
	req *pb.JoinRoomRequest,
) (*pb.JoinRoomResponse, error) {
	log.Printf("JoinRoom request: userId=%s, room=%s", req.UserId, req.RoomName)
	s.bsLogger.LogInfo("JoinRoom request received", map[string]interface{}{
		"user_id":     req.UserId,
		"room_name":   req.RoomName,
		"livekit_url": req.LivekitUrl,
	})

	// Check if session already exists
	if _, exists := s.sessions.Load(req.UserId); exists {
		s.bsLogger.LogWarn("Session already exists for user", map[string]interface{}{
			"user_id": req.UserId,
		})
		return &pb.JoinRoomResponse{
			Success: false,
			Error:   "session already exists for this user",
		}, nil
	}

	// Create new session
	session := NewRoomSession(req.UserId)

	// Setup callbacks for LiveKit room
	var receivedPackets int64
	var droppedPackets int64

	roomCallback := &lksdk.RoomCallback{
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
						s.bsLogger.LogDebug("Audio flowing from LiveKit", map[string]interface{}{
							"user_id":     req.UserId,
							"received":    receivedPackets,
							"dropped":     droppedPackets,
							"channel_len": len(session.audioFromLiveKit),
							"room_name":   req.RoomName,
						})
						log.Printf("Audio flowing for %s: received=%d, dropped=%d, channelLen=%d",
							req.UserId, receivedPackets, droppedPackets, len(session.audioFromLiveKit))
					}
				default:
					// Drop frame if channel full (backpressure)
					droppedPackets++
					if droppedPackets%50 == 0 {
						s.bsLogger.LogWarn("Dropping audio frames", map[string]interface{}{
							"user_id":       req.UserId,
							"total_dropped": droppedPackets,
							"channel_full":  len(session.audioFromLiveKit),
							"room_name":     req.RoomName,
						})
						log.Printf("Dropping audio frames for %s: total_dropped=%d, channel_full=%d",
							req.UserId, droppedPackets, len(session.audioFromLiveKit))
					}
				}
			},
		},
		OnDisconnected: func() {
			log.Printf("Disconnected from LiveKit room: %s", req.RoomName)
			s.bsLogger.LogWarn("Disconnected from LiveKit room", map[string]interface{}{
				"user_id":   req.UserId,
				"room_name": req.RoomName,
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
		s.bsLogger.LogError("Failed to connect to LiveKit room", err, map[string]interface{}{
			"user_id":     req.UserId,
			"room_name":   req.RoomName,
			"livekit_url": req.LivekitUrl,
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

	s.bsLogger.LogInfo("Successfully joined LiveKit room", map[string]interface{}{
		"user_id":           req.UserId,
		"room_name":         req.RoomName,
		"participant_id":    string(room.LocalParticipant.Identity()),
		"participant_count": len(room.GetRemoteParticipants()) + 1,
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
	log.Printf("LeaveRoom request: userId=%s", req.UserId)
	s.bsLogger.LogInfo("LeaveRoom request received", map[string]interface{}{
		"user_id": req.UserId,
	})

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		return &pb.LeaveRoomResponse{
			Success: false,
			Error:   "session not found",
		}, nil
	}

	session := sessionVal.(*RoomSession)
	session.Close()
	s.sessions.Delete(req.UserId)

	log.Printf("Successfully left room: userId=%s", req.UserId)

	return &pb.LeaveRoomResponse{
		Success: true,
	}, nil
}

// StreamAudio handles bidirectional audio streaming
func (s *LiveKitBridgeService) StreamAudio(
	stream pb.LiveKitBridge_StreamAudioServer,
) error {
	// Get userId from first message
	firstChunk, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "failed to receive initial chunk: %v", err)
	}

	userId := firstChunk.UserId
	if userId == "" {
		return status.Errorf(codes.InvalidArgument, "userId required in first chunk")
	}

	log.Printf("StreamAudio started: userId=%s", userId)

	// Get session
	sessionVal, ok := s.sessions.Load(userId)
	if !ok {
		return status.Errorf(codes.NotFound, "session not found for user %s", userId)
	}
	session := sessionVal.(*RoomSession)

	// Error channel for goroutine communication
	errChan := make(chan error, 2)

	// Goroutine 1: Receive from client → LiveKit
	go func() {
		defer log.Printf("StreamAudio receive goroutine ended: userId=%s", userId)

		// Process first chunk with track ID
		trackName := trackIDToName(firstChunk.TrackId)
		if err := session.writeAudioToTrack(firstChunk.PcmData, trackName); err != nil {
			errChan <- fmt.Errorf("failed to write first chunk: %w", err)
			return
		}

		// Continue receiving
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				errChan <- fmt.Errorf("receive error: %w", err)
				return
			}

			// Convert track_id to track name
			trackName := trackIDToName(chunk.TrackId)
			if err := session.writeAudioToTrack(chunk.PcmData, trackName); err != nil {
				errChan <- fmt.Errorf("failed to write audio: %w", err)
				return
			}
		}
	}()

	// Goroutine 2: Send from LiveKit → client
	go func() {
		defer log.Printf("StreamAudio send goroutine ended: userId=%s", userId)

		var sentPackets int64
		var sendErrors int64

		for {
			select {
			case audioData, ok := <-session.audioFromLiveKit:
				if !ok {
					return
				}

				// Send to client with timeout to prevent blocking forever
				sendDone := make(chan error, 1)
				go func() {
					sendDone <- stream.Send(&pb.AudioChunk{
						PcmData:     audioData,
						SampleRate:  16000,
						Channels:    1,
						TimestampMs: 0,
					})
				}()

				select {
				case err := <-sendDone:
					if err != nil {
						sendErrors++
						log.Printf("StreamAudio send error for %s: %v (errors=%d)", userId, err, sendErrors)
						errChan <- fmt.Errorf("send error: %w", err)
						return
					}
					sentPackets++
					if sentPackets%100 == 0 {
						s.bsLogger.LogDebug("Sent audio chunks to TypeScript", map[string]interface{}{
							"user_id":     userId,
							"sent":        sentPackets,
							"channel_len": len(session.audioFromLiveKit),
						})
						log.Printf("Sent %d audio chunks to TypeScript for user %s (channelLen=%d)",
							sentPackets, userId, len(session.audioFromLiveKit))
					}
				case <-time.After(2 * time.Second):
					s.bsLogger.LogError("StreamAudio send timeout", fmt.Errorf("timeout after 2s"), map[string]interface{}{
						"user_id": userId,
					})
					log.Printf("StreamAudio send timeout for %s after 2s, client may be stuck", userId)
					errChan <- fmt.Errorf("send timeout after 2s")
					return
				case <-session.ctx.Done():
					return
				}

			case <-session.ctx.Done():
				return
			}
		}
	}()

	// Wait for error or cancellation
	select {
	case err := <-errChan:
		s.bsLogger.LogError("StreamAudio error", err, map[string]interface{}{
			"user_id": userId,
		})
		log.Printf("StreamAudio error for userId=%s: %v", userId, err)

		// CRITICAL: Clean up session on stream error
		// This prevents zombie sessions and "channel full" errors after reconnection issues
		s.bsLogger.LogWarn("Cleaning up session due to stream error", map[string]interface{}{
			"user_id": userId,
		})
		log.Printf("Cleaning up session for %s due to stream error", userId)
		session.Close()
		s.sessions.Delete(userId)

		return err
	case <-session.ctx.Done():
		log.Printf("StreamAudio context done: userId=%s", userId)
		return nil
	}
}

// PlayAudio handles server-side audio playback
func (s *LiveKitBridgeService) PlayAudio(
	req *pb.PlayAudioRequest,
	stream pb.LiveKitBridge_PlayAudioServer,
) error {
	log.Printf("PlayAudio request: userId=%s, url=%s", req.UserId, req.AudioUrl)

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		return status.Errorf(codes.NotFound, "session not found for user %s", req.UserId)
	}
	session := sessionVal.(*RoomSession)

	// Send STARTED event
	if err := stream.Send(&pb.PlayAudioEvent{
		Type:      pb.PlayAudioEvent_STARTED,
		RequestId: req.RequestId,
	}); err != nil {
		return err
	}

	// Convert track_id to track name
	trackName := trackIDToName(req.TrackId)

	// Play audio file (implementation in playback.go)
	duration, err := s.playAudioFile(req, session, stream, trackName)
	if err != nil {
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
	if err := stream.Send(&pb.PlayAudioEvent{
		Type:       pb.PlayAudioEvent_COMPLETED,
		RequestId:  req.RequestId,
		DurationMs: duration,
	}); err != nil {
		return err
	}

	// Close only this specific track after playback to prevent static feedback
	session.closeTrack(trackName)

	return nil
}

// StopAudio handles stopping audio playback
func (s *LiveKitBridgeService) StopAudio(
	ctx context.Context,
	req *pb.StopAudioRequest,
) (*pb.StopAudioResponse, error) {
	log.Printf("StopAudio request: userId=%s, trackId=%d", req.UserId, req.TrackId)

	sessionVal, ok := s.sessions.Load(req.UserId)
	if !ok {
		return &pb.StopAudioResponse{
			Success: false,
			Error:   "session not found",
		}, nil
	}

	session := sessionVal.(*RoomSession)

	// Convert track_id to track name
	trackName := trackIDToName(req.TrackId)

	// Cancel playback for this track
	session.stopPlayback()

	// Close only the specific track
	session.closeTrack(trackName)

	return &pb.StopAudioResponse{
		Success:          true,
		StoppedRequestId: req.RequestId,
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

	return &pb.HealthCheckResponse{
		Status:         pb.HealthCheckResponse_SERVING,
		ActiveSessions: activeSessions,
		ActiveStreams:  activeStreams,
		UptimeSeconds:  0, // Could track uptime if needed
	}, nil
}

// getSession is a helper to safely get a session
func (s *LiveKitBridgeService) getSession(userId string) (*RoomSession, error) {
	sessionVal, ok := s.sessions.Load(userId)
	if !ok {
		return nil, fmt.Errorf("session not found for user %s", userId)
	}
	return sessionVal.(*RoomSession), nil
}

// GetStatus returns room connectivity state for a given user session
func (s *LiveKitBridgeService) GetStatus(ctx context.Context, req *pb.BridgeStatusRequest) (*pb.BridgeStatusResponse, error) {
	// Default response if no session
	resp := &pb.BridgeStatusResponse{
		Connected:            false,
		ParticipantId:        "",
		ParticipantCount:     0,
		LastDisconnectAt:     0,
		LastDisconnectReason: "",
		ServerVersion:        "1.0.0",
	}

	if req == nil || req.UserId == "" {
		return resp, nil
	}

	val, ok := s.sessions.Load(req.UserId)
	if !ok {
		// No session found: return defaults (connected=false)
		return resp, nil
	}

	session := val.(*RoomSession)

	// Collect state under lock
	session.mu.RLock()
	connected := session.connected
	participantID := session.participantID
	participantCount := session.participantCount
	lastDiscAt := session.lastDisconnectAt
	lastDiscReason := session.lastDisconnectReason
	room := session.room
	session.mu.RUnlock()

	// If we have a room, prefer live counts/ids
	if room != nil {
		if participantID == "" {
			participantID = string(room.LocalParticipant.Identity())
		}
		participantCount = len(room.GetRemoteParticipants()) + 1
	}

	resp.Connected = connected
	resp.ParticipantId = participantID
	resp.ParticipantCount = int32(participantCount)
	if !lastDiscAt.IsZero() {
		resp.LastDisconnectAt = lastDiscAt.UnixMilli()
	}
	resp.LastDisconnectReason = lastDiscReason

	return resp, nil
}
