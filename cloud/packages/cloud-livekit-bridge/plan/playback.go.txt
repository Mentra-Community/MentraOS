package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	pb "github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/proto"
	mp3 "github.com/hajimehoshi/go-mp3"
)

// playAudioFile handles downloading and playing audio files
func (s *LiveKitBridgeService) playAudioFile(
	req *pb.PlayAudioRequest,
	session *RoomSession,
	stream pb.LiveKitBridge_PlayAudioServer,
	trackName string,
) (int64, error) {
	// Create cancellable context for playback
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	// Store cancel function in session for StopAudio
	session.mu.Lock()
	session.playbackCancel = cancel
	session.mu.Unlock()

	// Fetch audio file
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, req.AudioUrl, nil)
	if err != nil {
		return 0, fmt.Errorf("invalid URL: %w", err)
	}

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch audio: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("HTTP error: %d %s", resp.StatusCode, resp.Status)
	}

	// Detect content type
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	url := strings.ToLower(req.AudioUrl)

	log.Printf("Playing audio: url=%s, contentType=%s", req.AudioUrl, contentType)

	// Route to appropriate decoder
	if strings.Contains(contentType, "audio/mpeg") || strings.HasSuffix(url, ".mp3") {
		return s.playMP3(ctx, resp.Body, req, session, trackName)
	} else if strings.Contains(contentType, "audio/wav") ||
		strings.Contains(contentType, "audio/x-wav") ||
		strings.Contains(contentType, "audio/wave") ||
		strings.HasSuffix(url, ".wav") {
		return s.playWAV(ctx, resp.Body, req, session, trackName)
	}

	return 0, fmt.Errorf("unsupported audio format: %s", contentType)
}

// playMP3 decodes and plays MP3 audio
func (s *LiveKitBridgeService) playMP3(
	ctx context.Context,
	r io.Reader,
	req *pb.PlayAudioRequest,
	session *RoomSession,
	trackName string,
) (int64, error) {
	// Create MP3 decoder
	dec, err := mp3.NewDecoder(r)
	if err != nil {
		return 0, fmt.Errorf("MP3 decode error: %w", err)
	}

	srcSR := dec.SampleRate()
	if srcSR <= 0 {
		return 0, fmt.Errorf("invalid MP3 sample rate")
	}

	const dstSR = 16000
	resampler := &resampleState{step: float64(srcSR) / float64(dstSR)}

	buf := make([]byte, 4096)
	var totalSamples int64
	startTime := time.Now()

	for {
		// Check for cancellation
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}

		n, err := dec.Read(buf)
		if n > 0 {
			// Convert bytes to int16 samples
			samples := bytesToInt16(buf[:n])

			// Downmix stereo to mono (MP3 is typically stereo)
			if len(samples) >= 2 {
				mono := make([]int16, len(samples)/2)
				for i := 0; i+1 < len(samples); i += 2 {
					v := int32(samples[i]) + int32(samples[i+1])
					mono[i/2] = int16(v / 2)
				}
				samples = mono
			}

			// Resample to 16kHz
			resampled := resampler.push(samples)
			if len(resampled) > 0 {
				// Apply volume
				if req.Volume > 0 && req.Volume != 1.0 {
					applyGain(resampled, float64(req.Volume))
				}

				// Write to LiveKit in 10ms chunks
				if err := session.writeAudioToTrack(int16ToBytes(resampled), trackName); err != nil {
					return 0, fmt.Errorf("failed to write audio: %w", err)
				}

				totalSamples += int64(len(resampled))
			}
		}

		if err != nil {
			if !errors.Is(err, io.EOF) {
				return 0, fmt.Errorf("MP3 read error: %w", err)
			}
			break
		}
	}

	duration := time.Since(startTime).Milliseconds()
	log.Printf("MP3 playback complete: samples=%d, duration=%dms", totalSamples, duration)

	return duration, nil
}

// playWAV decodes and plays WAV audio
func (s *LiveKitBridgeService) playWAV(
	ctx context.Context,
	r io.Reader,
	req *pb.PlayAudioRequest,
	session *RoomSession,
	trackName string,
) (int64, error) {
	br := bufio.NewReader(r)

	// Parse RIFF header
	header := make([]byte, 12)
	if _, err := io.ReadFull(br, header); err != nil {
		return 0, fmt.Errorf("failed to read WAV header: %w", err)
	}

	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return 0, fmt.Errorf("not a valid WAV file")
	}

	var numChannels uint16
	var sampleRate uint32
	var bitsPerSample uint16
	var dataBytes uint32

	haveFmt := false
	haveData := false

	// Read chunks until we find fmt and data
	for {
		hdr := make([]byte, 8)
		if _, err := io.ReadFull(br, hdr); err != nil {
			return 0, fmt.Errorf("failed to read chunk header: %w", err)
		}

		chunkID := string(hdr[0:4])
		size := binary.LittleEndian.Uint32(hdr[4:8])

		if chunkID == "fmt " {
			buf := make([]byte, size)
			if _, err := io.ReadFull(br, buf); err != nil {
				return 0, fmt.Errorf("failed to read fmt chunk: %w", err)
			}

			// Consume padding byte if odd size
			if size%2 == 1 {
				br.ReadByte()
			}

			if size < 16 {
				return 0, fmt.Errorf("fmt chunk too short")
			}

			audioFormat := binary.LittleEndian.Uint16(buf[0:2])
			numChannels = binary.LittleEndian.Uint16(buf[2:4])
			sampleRate = binary.LittleEndian.Uint32(buf[4:8])
			bitsPerSample = binary.LittleEndian.Uint16(buf[14:16])

			if audioFormat != 1 {
				return 0, fmt.Errorf("only PCM WAV supported")
			}
			if bitsPerSample != 16 {
				return 0, fmt.Errorf("only 16-bit WAV supported")
			}
			if numChannels != 1 && numChannels != 2 {
				return 0, fmt.Errorf("only mono/stereo WAV supported")
			}

			haveFmt = true

		} else if chunkID == "data" {
			dataBytes = size
			haveData = true
			break
		} else {
			// Skip unknown chunk
			if _, err := io.CopyN(io.Discard, br, int64(size)); err != nil {
				return 0, fmt.Errorf("failed to skip chunk: %w", err)
			}
			if size%2 == 1 {
				br.ReadByte()
			}
		}
	}

	if !haveFmt || !haveData {
		return 0, fmt.Errorf("missing fmt or data chunk")
	}

	const dstSR = 16000
	resampler := &resampleState{step: float64(sampleRate) / float64(dstSR)}

	bytesPerFrame := int(bitsPerSample/8) * int(numChannels)
	if bytesPerFrame <= 0 {
		return 0, fmt.Errorf("invalid frame size")
	}

	readLeft := int64(dataBytes)
	buf := make([]byte, 4096-(4096%bytesPerFrame))
	if len(buf) == 0 {
		buf = make([]byte, bytesPerFrame)
	}

	var totalSamples int64
	startTime := time.Now()

	for readLeft > 0 {
		// Check for cancellation
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}

		toRead := int64(len(buf))
		if toRead > readLeft {
			toRead = readLeft
		}

		n, err := io.ReadFull(br, buf[:toRead])
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return 0, fmt.Errorf("failed to read audio data: %w", err)
		}
		if n <= 0 {
			break
		}

		readLeft -= int64(n)
		data := buf[:n]

		// Convert to mono int16 samples
		samples := bytesToInt16(data)
		var mono []int16

		if numChannels == 1 {
			mono = samples
		} else {
			// Downmix stereo to mono
			mono = make([]int16, len(samples)/2)
			for i := 0; i+1 < len(samples); i += 2 {
				v := int32(samples[i]) + int32(samples[i+1])
				mono[i/2] = int16(v / 2)
			}
		}

		// Resample if needed
		var output []int16
		if int(sampleRate) != dstSR {
			output = resampler.push(mono)
		} else {
			output = mono
		}

		if len(output) > 0 {
			// Apply volume
			if req.Volume > 0 && req.Volume != 1.0 {
				applyGain(output, float64(req.Volume))
			}

			// Write to LiveKit
			if err := session.writeAudioToTrack(int16ToBytes(output), trackName); err != nil {
				return 0, fmt.Errorf("failed to write audio: %w", err)
			}

			totalSamples += int64(len(output))
		}
	}

	duration := time.Since(startTime).Milliseconds()
	log.Printf("WAV playback complete: samples=%d, duration=%dms", totalSamples, duration)

	return duration, nil
}

// applyGain applies volume scaling to audio samples
func applyGain(samples []int16, gain float64) {
	if gain == 1.0 {
		return
	}
	for i := range samples {
		v := float64(samples[i]) * gain
		if v > 32767 {
			v = 32767
		} else if v < -32768 {
			v = -32768
		}
		samples[i] = int16(v)
	}
}

// resampleState holds state for audio resampling
type resampleState struct {
	buf  []int16
	pos  float64
	step float64
}

// push adds samples to the resampler and returns resampled output
func (r *resampleState) push(in []int16) []int16 {
	r.buf = append(r.buf, in...)
	if len(r.buf) < 2 {
		return nil
	}

	var out []int16
	for {
		i := int(r.pos)
		if i+1 >= len(r.buf) {
			break
		}

		// Linear interpolation
		frac := r.pos - float64(i)
		s0 := float64(r.buf[i])
		s1 := float64(r.buf[i+1])
		v := s0 + (s1-s0)*frac

		if v > 32767 {
			v = 32767
		} else if v < -32768 {
			v = -32768
		}

		out = append(out, int16(v))
		r.pos += r.step
	}

	// Keep unconsumed samples
	drop := int(r.pos)
	if drop > 0 {
		if drop >= len(r.buf) {
			r.buf = r.buf[:0]
			r.pos = 0
		} else {
			r.buf = r.buf[drop:]
			r.pos -= float64(drop)
		}
	}

	return out
}
