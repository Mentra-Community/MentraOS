package logger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// BetterStackLogger sends logs to Better Stack HTTP endpoint
type BetterStackLogger struct {
	token         string
	ingestingHost string
	client        *http.Client
	batchSize     int
	flushInterval time.Duration
	buffer        []LogEntry
	bufferMu      sync.Mutex
	stopCh        chan struct{}
	wg            sync.WaitGroup
	enabled       bool
	// Global context fields
	env    string
	server string
	region string
}

// LogEntry represents a single log entry matching TypeScript pino format
type LogEntry struct {
	// Core fields (matching TypeScript logs)
	Message string `json:"message"`
	Level   string `json:"level,omitempty"`
	Dt      string `json:"dt"`
	Env     string `json:"env,omitempty"`
	Server  string `json:"server,omitempty"`
	Region  string `json:"region,omitempty"`
	Service string `json:"service,omitempty"`
	Feature string `json:"feature,omitempty"`

	// User context (at root level to match TypeScript)
	UserID    string `json:"userId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	RoomName  string `json:"roomName,omitempty"`

	// Error handling
	Error     string       `json:"error,omitempty"`
	ErrorCode string       `json:"errorCode,omitempty"`
	Err       *ErrorDetail `json:"err,omitempty"`

	// Request tracking
	RequestID string `json:"requestId,omitempty"`
	TrackID   int32  `json:"trackId,omitempty"`
	TrackName string `json:"trackName,omitempty"`

	// Audio specific fields
	AudioURL    string `json:"audioUrl,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	DurationMs  int64  `json:"durationMs,omitempty"`
	SampleRate  int    `json:"sampleRate,omitempty"`
	Channels    int    `json:"channels,omitempty"`
	BytesRead   int64  `json:"bytesRead,omitempty"`

	// LiveKit specific
	LiveKitURL       string `json:"livekitUrl,omitempty"`
	ParticipantID    string `json:"participantId,omitempty"`
	ParticipantCount int    `json:"participantCount,omitempty"`
	TargetIdentity   string `json:"targetIdentity,omitempty"`

	// Metrics
	ReceivedPackets int64 `json:"receivedPackets,omitempty"`
	DroppedPackets  int64 `json:"droppedPackets,omitempty"`
	ChannelLen      int   `json:"channelLen,omitempty"`
	TotalSamples    int64 `json:"totalSamples,omitempty"`

	// Extra fields for anything else
	Extra map[string]interface{} `json:"extra,omitempty"`
}

// ErrorDetail provides structured error information matching TypeScript format
type ErrorDetail struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
	Stack   string `json:"stack,omitempty"`
	Code    string `json:"code,omitempty"`
}

// Config for BetterStackLogger
type Config struct {
	Token         string
	IngestingHost string
	BatchSize     int
	FlushInterval time.Duration
	Enabled       bool
	Env           string
	Server        string
	Region        string
}

// NewBetterStackLogger creates a new Better Stack logger
func NewBetterStackLogger(cfg Config) *BetterStackLogger {
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 10
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 5 * time.Second
	}

	logger := &BetterStackLogger{
		token:         cfg.Token,
		ingestingHost: cfg.IngestingHost,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		batchSize:     cfg.BatchSize,
		flushInterval: cfg.FlushInterval,
		buffer:        make([]LogEntry, 0, cfg.BatchSize),
		stopCh:        make(chan struct{}),
		enabled:       cfg.Enabled,
		env:           cfg.Env,
		server:        cfg.Server,
		region:        cfg.Region,
	}

	if logger.enabled {
		logger.wg.Add(1)
		go logger.flushWorker()
	}

	return logger
}

// Log sends a log entry to Better Stack
func (l *BetterStackLogger) Log(entry LogEntry) {
	if !l.enabled {
		return
	}

	// Set timestamp if not provided
	if entry.Dt == "" {
		entry.Dt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	// Set global context fields if not already set
	if entry.Env == "" {
		entry.Env = l.env
	}
	if entry.Server == "" {
		entry.Server = l.server
	}
	if entry.Region == "" {
		entry.Region = l.region
	}
	if entry.Service == "" {
		entry.Service = "livekit-bridge"
	}

	l.bufferMu.Lock()
	l.buffer = append(l.buffer, entry)
	shouldFlush := len(l.buffer) >= l.batchSize
	l.bufferMu.Unlock()

	if shouldFlush {
		l.Flush()
	}
}

// LogContext holds user/session context for creating child loggers
type LogContext struct {
	UserID    string
	SessionID string
	RoomName  string
	RequestID string
	TrackID   int32
	TrackName string
	Feature   string
}

// WithContext creates a new entry with context pre-filled
func (l *BetterStackLogger) WithContext(ctx LogContext) *ContextLogger {
	return &ContextLogger{
		parent: l,
		ctx:    ctx,
	}
}

// ContextLogger is a logger with pre-filled context
type ContextLogger struct {
	parent *BetterStackLogger
	ctx    LogContext
}

// Info logs an info message with context
func (cl *ContextLogger) Info(message string, entry LogEntry) {
	entry.Level = "info"
	entry.Message = message
	cl.applyContext(&entry)
	cl.parent.Log(entry)
}

// Debug logs a debug message with context
func (cl *ContextLogger) Debug(message string, entry LogEntry) {
	entry.Level = "debug"
	entry.Message = message
	cl.applyContext(&entry)
	cl.parent.Log(entry)
}

// Warn logs a warning message with context
func (cl *ContextLogger) Warn(message string, entry LogEntry) {
	entry.Level = "warn"
	entry.Message = message
	cl.applyContext(&entry)
	cl.parent.Log(entry)
}

// Error logs an error message with context
func (cl *ContextLogger) Error(message string, err error, entry LogEntry) {
	entry.Level = "error"
	entry.Message = message
	if err != nil {
		entry.Error = err.Error()
		entry.Err = &ErrorDetail{
			Type:    "Error",
			Message: err.Error(),
		}
	}
	cl.applyContext(&entry)
	cl.parent.Log(entry)
}

func (cl *ContextLogger) applyContext(entry *LogEntry) {
	if entry.UserID == "" {
		entry.UserID = cl.ctx.UserID
	}
	if entry.SessionID == "" {
		entry.SessionID = cl.ctx.SessionID
	}
	if entry.RoomName == "" {
		entry.RoomName = cl.ctx.RoomName
	}
	if entry.RequestID == "" {
		entry.RequestID = cl.ctx.RequestID
	}
	if entry.TrackID == 0 && cl.ctx.TrackID != 0 {
		entry.TrackID = cl.ctx.TrackID
	}
	if entry.TrackName == "" {
		entry.TrackName = cl.ctx.TrackName
	}
	if entry.Feature == "" {
		entry.Feature = cl.ctx.Feature
	}
}

// LogInfo logs an info message (simple API)
func (l *BetterStackLogger) LogInfo(message string, fields map[string]interface{}) {
	entry := LogEntry{
		Message: message,
		Level:   "info",
		Extra:   fields,
	}
	l.extractKnownFields(&entry, fields)
	l.Log(entry)
}

// LogError logs an error message (simple API)
func (l *BetterStackLogger) LogError(message string, err error, fields map[string]interface{}) {
	if fields == nil {
		fields = make(map[string]interface{})
	}

	entry := LogEntry{
		Message: message,
		Level:   "error",
		Extra:   fields,
	}

	if err != nil {
		entry.Error = err.Error()
		entry.Err = &ErrorDetail{
			Type:    "Error",
			Message: err.Error(),
		}
	}

	l.extractKnownFields(&entry, fields)
	l.Log(entry)
}

// LogDebug logs a debug message (simple API)
func (l *BetterStackLogger) LogDebug(message string, fields map[string]interface{}) {
	entry := LogEntry{
		Message: message,
		Level:   "debug",
		Extra:   fields,
	}
	l.extractKnownFields(&entry, fields)
	l.Log(entry)
}

// LogWarn logs a warning message (simple API)
func (l *BetterStackLogger) LogWarn(message string, fields map[string]interface{}) {
	entry := LogEntry{
		Message: message,
		Level:   "warn",
		Extra:   fields,
	}
	l.extractKnownFields(&entry, fields)
	l.Log(entry)
}

// extractKnownFields moves known fields from Extra map to typed fields
func (l *BetterStackLogger) extractKnownFields(entry *LogEntry, fields map[string]interface{}) {
	if fields == nil {
		return
	}

	// Extract and remove known fields from Extra
	if v, ok := fields["user_id"].(string); ok {
		entry.UserID = v
		delete(fields, "user_id")
	}
	if v, ok := fields["userId"].(string); ok {
		entry.UserID = v
		delete(fields, "userId")
	}
	if v, ok := fields["session_id"].(string); ok {
		entry.SessionID = v
		delete(fields, "session_id")
	}
	if v, ok := fields["room_name"].(string); ok {
		entry.RoomName = v
		delete(fields, "room_name")
	}
	if v, ok := fields["request_id"].(string); ok {
		entry.RequestID = v
		delete(fields, "request_id")
	}
	if v, ok := fields["feature"].(string); ok {
		entry.Feature = v
		delete(fields, "feature")
	}
	if v, ok := fields["livekit_url"].(string); ok {
		entry.LiveKitURL = v
		delete(fields, "livekit_url")
	}
	if v, ok := fields["participant_id"].(string); ok {
		entry.ParticipantID = v
		delete(fields, "participant_id")
	}
	if v, ok := fields["participant_count"].(int); ok {
		entry.ParticipantCount = v
		delete(fields, "participant_count")
	}
	if v, ok := fields["audio_url"].(string); ok {
		entry.AudioURL = v
		delete(fields, "audio_url")
	}
	if v, ok := fields["content_type"].(string); ok {
		entry.ContentType = v
		delete(fields, "content_type")
	}
	if v, ok := fields["duration_ms"].(int64); ok {
		entry.DurationMs = v
		delete(fields, "duration_ms")
	}
	if v, ok := fields["track_name"].(string); ok {
		entry.TrackName = v
		delete(fields, "track_name")
	}

	// Clear Extra if empty
	if len(fields) == 0 {
		entry.Extra = nil
	}
}

// Flush sends all buffered logs immediately
func (l *BetterStackLogger) Flush() {
	if !l.enabled {
		return
	}

	l.bufferMu.Lock()
	if len(l.buffer) == 0 {
		l.bufferMu.Unlock()
		return
	}

	// Copy buffer and clear it
	entries := make([]LogEntry, len(l.buffer))
	copy(entries, l.buffer)
	l.buffer = l.buffer[:0]
	l.bufferMu.Unlock()

	// Send in background to avoid blocking
	go l.sendBatch(entries)
}

// sendBatch sends a batch of log entries to Better Stack
func (l *BetterStackLogger) sendBatch(entries []LogEntry) {
	if len(entries) == 0 {
		return
	}

	jsonData, err := json.Marshal(entries)
	if err != nil {
		log.Printf("[BetterStack] Failed to marshal log entries: %v", err)
		return
	}

	url := fmt.Sprintf("https://%s", l.ingestingHost)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[BetterStack] Failed to create request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", l.token))

	resp, err := l.client.Do(req)
	if err != nil {
		log.Printf("[BetterStack] Failed to send logs: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[BetterStack] Failed to send logs (status %d): %s", resp.StatusCode, string(body))
	}
}

// flushWorker periodically flushes the buffer
func (l *BetterStackLogger) flushWorker() {
	defer l.wg.Done()

	ticker := time.NewTicker(l.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			l.Flush()
		case <-l.stopCh:
			l.Flush() // Final flush on shutdown
			return
		}
	}
}

// Close stops the logger and flushes remaining logs
func (l *BetterStackLogger) Close() {
	if !l.enabled {
		return
	}

	close(l.stopCh)
	l.wg.Wait()
}

// NewFromEnv creates a BetterStackLogger from environment variables
func NewFromEnv() *BetterStackLogger {
	token := os.Getenv("BETTERSTACK_SOURCE_TOKEN")
	host := os.Getenv("BETTERSTACK_INGESTING_HOST")
	enabled := token != "" && host != ""

	// Get environment context
	env := os.Getenv("NODE_ENV")
	if env == "" {
		env = os.Getenv("ENV")
	}
	if env == "" {
		env = "development"
	}

	server := os.Getenv("SERVER_NAME")
	if server == "" {
		server = "livekit-bridge"
	}

	region := os.Getenv("REGION")
	if region == "" {
		region = os.Getenv("AZURE_REGION")
	}

	if !enabled {
		log.Println("[BetterStack] Logger disabled (missing BETTERSTACK_SOURCE_TOKEN or BETTERSTACK_INGESTING_HOST)")
	} else {
		log.Printf("[BetterStack] Logger enabled, sending to %s (env=%s, server=%s, region=%s)", host, env, server, region)
	}

	return NewBetterStackLogger(Config{
		Token:         token,
		IngestingHost: host,
		BatchSize:     10,
		FlushInterval: 5 * time.Second,
		Enabled:       enabled,
		Env:           env,
		Server:        server,
		Region:        region,
	})
}
