package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/joho/godotenv"
	lkauth "github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
)

// Simple WAV loop publisher.
// Reads a 16-bit PCM WAV file into memory and publishes it as a looping
// LiveKit audio track by writing fixed-size frames (default 10ms) to a
// PCMLocalTrack. Meant to be easy to follow for someone coming from TS.

// Flags (explicit, descriptive)
var (
	flagURL       string
	flagToken     string
	flagAPIKey    string
	flagAPISecret string
	flagRoom      string
	flagIdentity  string
	flagWavPath   string
	flagTrackName string
	flagGain      float64
	flagOnce      bool
	flagFrameMs   int
	flagLogEvery  int
)

func init() {
	flag.StringVar(&flagURL, "url", os.Getenv("LIVEKIT_URL"), "LiveKit WebSocket URL (wss://...) or env LIVEKIT_URL")
	flag.StringVar(&flagToken, "token", os.Getenv("LIVEKIT_TOKEN"), "Pre-minted token (optional if api key/secret provided)")
	flag.StringVar(&flagAPIKey, "api-key", os.Getenv("LIVEKIT_API_KEY"), "API key (for on-the-fly token mint)")
	flag.StringVar(&flagAPISecret, "api-secret", os.Getenv("LIVEKIT_API_SECRET"), "API secret (for on-the-fly token mint)")
	flag.StringVar(&flagRoom, "room", os.Getenv("LIVEKIT_ROOM_NAME"), "Room name to join")
	flag.StringVar(&flagIdentity, "identity", os.Getenv("LIVEKIT_IDENTITY"), "Participant identity (auto-generated if empty)")
	flag.StringVar(&flagWavPath, "wav", "", "Path to 16-bit PCM WAV file")
	flag.StringVar(&flagTrackName, "track-name", "loop", "Track name to publish")
	flag.Float64Var(&flagGain, "gain", 1.0, "Linear gain (1.0 = unchanged)")
	flag.BoolVar(&flagOnce, "once", false, "Play the WAV only once (default: loop)")
	flag.IntVar(&flagFrameMs, "frame-ms", 10, "Frame size in ms (typ 10)")
	flag.IntVar(&flagLogEvery, "log-every", 100, "Log every N frames (0=disable)")
}

func main() {
	// Load .env if present (ignore error to allow clean env-only usage)
	_ = godotenv.Load()
	flag.Parse()
	// After parsing, if critical flags empty, fill from env (already set by godotenv)
	if flagURL == "" {
		flagURL = os.Getenv("LIVEKIT_URL")
	}
	if flagRoom == "" {
		flagRoom = os.Getenv("LIVEKIT_ROOM_NAME")
	}
	if flagToken == "" {
		flagToken = os.Getenv("LIVEKIT_TOKEN")
	}
	if flagAPIKey == "" {
		flagAPIKey = os.Getenv("LIVEKIT_API_KEY")
	}
	if flagAPISecret == "" {
		flagAPISecret = os.Getenv("LIVEKIT_API_SECRET")
	}
	if flagIdentity == "" {
		flagIdentity = os.Getenv("LIVEKIT_IDENTITY")
	}
	if err := run(); err != nil {
		log.Fatalf("error: %v", err)
	}
}

func run() error {
	if flagURL == "" {
		return errors.New("--url or LIVEKIT_URL required")
	}
	if flagRoom == "" {
		return errors.New("--room or LIVEKIT_ROOM_NAME required")
	}
	if flagWavPath == "" {
		return errors.New("--wav path required")
	}
	abs, _ := filepath.Abs(flagWavPath)
	log.Printf("wav file: %s", abs)
	wav, err := loadWAV(flagWavPath)
	if err != nil {
		return fmt.Errorf("load wav: %w", err)
	}
	log.Printf("wav: sr=%d ch=%d bits=%d bytes=%d dur=%.2fs", wav.SampleRate, wav.Channels, wav.BitsPerSample, len(wav.Data), wav.DurationSeconds())
	if wav.BitsPerSample != 16 {
		return fmt.Errorf("need 16-bit pcm, got %d", wav.BitsPerSample)
	}
	if wav.SampleRate <= 0 {
		return fmt.Errorf("bad sample rate %d", wav.SampleRate)
	}
	if wav.Channels < 1 || wav.Channels > 2 {
		return fmt.Errorf("unsupported channels=%d", wav.Channels)
	}
	if flagFrameMs <= 0 || flagFrameMs > 1000 {
		return fmt.Errorf("invalid frame-ms %d", flagFrameMs)
	}
	token := flagToken
	if token == "" {
		if flagAPIKey == "" || flagAPISecret == "" {
			return errors.New("either --token or (--api-key & --api-secret)")
		}
		if flagIdentity == "" {
			flagIdentity = fmt.Sprintf("publisher-%d", time.Now().UnixNano())
		}
		at := lkauth.NewAccessToken(flagAPIKey, flagAPISecret)
		at.SetIdentity(flagIdentity)
		at.SetName(flagIdentity)
		at.AddGrant(&lkauth.VideoGrant{RoomJoin: true, Room: flagRoom})
		jwt, err := at.ToJWT()
		if err != nil {
			return fmt.Errorf("mint token: %w", err)
		}
		token = jwt
		log.Printf("minted token for identity=%s room=%s", flagIdentity, flagRoom)
	} else if flagIdentity == "" {
		if sub, name := decodeJWTIdentity(token); sub != "" {
			flagIdentity = sub
		} else if name != "" {
			flagIdentity = name
		}
	}
	if flagIdentity == "" {
		flagIdentity = "publisher"
	}
	room, err := lksdk.ConnectToRoomWithToken(flagURL, token, &lksdk.RoomCallback{})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer room.Disconnect()
	log.Printf("connected: identity=%s remotes=%d", room.LocalParticipant.Identity(), len(room.GetRemoteParticipants()))
	track, err := lkmedia.NewPCMLocalTrack(wav.SampleRate, wav.Channels, nil)
	if err != nil {
		return fmt.Errorf("new PCM track: %w", err)
	}
	if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: flagTrackName}); err != nil {
		return fmt.Errorf("publish: %w", err)
	}
	log.Printf("published track '%s' (sr=%d ch=%d)", flagTrackName, wav.SampleRate, wav.Channels)
	samplesPerFrame := wav.SampleRate * wav.Channels * flagFrameMs / 1000
	if samplesPerFrame <= 0 {
		return fmt.Errorf("bad samplesPerFrame calc")
	}
	log.Printf("frame: %d ms = %d samples (%d bytes)", flagFrameMs, samplesPerFrame, samplesPerFrame*2)
	totalSamples := len(wav.Data) / 2
	pcm := make([]int16, totalSamples)
	for i := 0; i < totalSamples; i++ {
		pcm[i] = int16(binary.LittleEndian.Uint16(wav.Data[i*2 : i*2+2]))
	}
	if flagGain != 1.0 {
		applyGain(pcm, flagGain)
	}
	frameIndex := 0
	loopCount := 0
	ticker := time.NewTicker(time.Duration(flagFrameMs) * time.Millisecond)
	defer ticker.Stop()
	start := time.Now()
	log.Printf("starting playback; loop=%v", !flagOnce)
	for {
		<-ticker.C
		startSample := frameIndex * samplesPerFrame
		endSample := startSample + samplesPerFrame
		if endSample > len(pcm) {
			loopCount++
			if flagOnce {
				log.Printf("done: duration=%.2fs frames=%d loops=%d", time.Since(start).Seconds(), frameIndex, loopCount)
				break
			}
			frameIndex = 0
			startSample = 0
			endSample = samplesPerFrame
			if endSample > len(pcm) {
				endSample = len(pcm)
			}
		}
		if err := track.WriteSample(pcm[startSample:endSample]); err != nil {
			return fmt.Errorf("write sample: %w", err)
		}
		frameIndex++
		if flagLogEvery > 0 && frameIndex%flagLogEvery == 0 {
			playedMs := float64(frameIndex * flagFrameMs)
			log.Printf("progress: frames=%d loops=%d played=%.0fms", frameIndex, loopCount, playedMs)
		}
	}
	return nil
}

func applyGain(samples []int16, gain float64) {
	if gain == 1.0 {
		return
	}
	for i, v := range samples {
		scaled := float64(v) * gain
		if scaled > 32767 {
			scaled = 32767
		} else if scaled < -32768 {
			scaled = -32768
		}
		samples[i] = int16(scaled)
	}
}

type wavFile struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
	Data          []byte
}

func (w *wavFile) DurationSeconds() float64 {
	if w.SampleRate == 0 || w.Channels == 0 {
		return 0
	}
	samples := len(w.Data) / 2 / w.Channels
	return float64(samples) / float64(w.SampleRate)
}

func loadWAV(path string) (*wavFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	header := make([]byte, 12)
	if _, err := io.ReadFull(f, header); err != nil {
		return nil, err
	}
	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return nil, errors.New("not a RIFF/WAVE file")
	}
	var sampleRate, channels, bitsPerSample int
	var dataChunk []byte
	for {
		chunkHeader := make([]byte, 8)
		if _, err := io.ReadFull(f, chunkHeader); err != nil {
			return nil, fmt.Errorf("read chunk header: %w", err)
		}
		id := string(chunkHeader[0:4])
		size := int(binary.LittleEndian.Uint32(chunkHeader[4:8]))
		payload := make([]byte, size)
		if _, err := io.ReadFull(f, payload); err != nil {
			return nil, fmt.Errorf("read chunk %s: %w", id, err)
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, errors.New("fmt chunk too small")
			}
			if af := binary.LittleEndian.Uint16(payload[0:2]); af != 1 {
				return nil, fmt.Errorf("unsupported format=%d", af)
			}
			channels = int(binary.LittleEndian.Uint16(payload[2:4]))
			sampleRate = int(binary.LittleEndian.Uint32(payload[4:8]))
			bitsPerSample = int(binary.LittleEndian.Uint16(payload[14:16]))
		case "data":
			dataChunk = payload
		}
		if sampleRate != 0 && dataChunk != nil {
			break
		}
		stat, _ := f.Stat()
		if pos, _ := f.Seek(0, io.SeekCurrent); stat != nil && pos >= stat.Size() {
			break
		}
	}
	if sampleRate == 0 || dataChunk == nil {
		return nil, errors.New("missing fmt or data chunk")
	}
	return &wavFile{SampleRate: sampleRate, Channels: channels, BitsPerSample: bitsPerSample, Data: dataChunk}, nil
}

func decodeJWTIdentity(tok string) (sub, name string) {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return "", ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ""
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return "", ""
	}
	if v, ok := m["sub"].(string); ok {
		sub = v
	}
	if v, ok := m["name"].(string); ok {
		name = v
	}
	return sub, name
}

// End of file
