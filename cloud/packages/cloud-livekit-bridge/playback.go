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

	"github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/logger"
	pb "github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/proto"
	mp3 "github.com/hajimehoshi/go-mp3"
)

// playAudioFile handles downloading and playing audio files
func (s *LiveKitBridgeService) playAudioFile(
	req *pb.PlayAudioRequest,
	session *RoomSession,
	stream pb.LiveKitBridge_PlayAudioServer,
	trackName string,
	lg *logger.ContextLogger,
) (int64, error) {
	// Create cancellable context for playback
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	// Create done channel to signal when playback stops
	done := make(chan struct{})
	defer close(done) // Signal completion when function exits

	// Store cancel function and done channel in session for StopAudio
	session.mu.Lock()
	session.playbackCancel = cancel
	session.playbackDone = done
	session.mu.Unlock()

	lg.Debug("Fetching audio file", logger.LogEntry{
		AudioURL: req.AudioUrl,
	})

	// Fetch audio file
	fetchStart := time.Now()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, req.AudioUrl, nil)
	if err != nil {
		lg.Error("Failed to create HTTP request", err, logger.LogEntry{
			AudioURL: req.AudioUrl,
		})
		return 0, fmt.Errorf("invalid URL: %w", err)
	}

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		lg.Error("Failed to fetch audio file", err, logger.LogEntry{
			AudioURL:   req.AudioUrl,
			DurationMs: time.Since(fetchStart).Milliseconds(),
		})
		return 0, fmt.Errorf("failed to fetch audio: %w", err)
	}
	defer resp.Body.Close()

	fetchDuration := time.Since(fetchStart)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		lg.Error("HTTP error fetching audio", fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status), logger.LogEntry{
			AudioURL:   req.AudioUrl,
			DurationMs: fetchDuration.Milliseconds(),
			Extra: map[string]interface{}{
				"http_status":      resp.StatusCode,
				"http_status_text": resp.Status,
			},
		})
		return 0, fmt.Errorf("HTTP error: %d %s", resp.StatusCode, resp.Status)
	}

	// Detect content type
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	contentLength := resp.ContentLength
	url := strings.ToLower(req.AudioUrl)

	lg.Info("Audio file fetched successfully", logger.LogEntry{
		AudioURL:    req.AudioUrl,
		ContentType: contentType,
		DurationMs:  fetchDuration.Milliseconds(),
		Extra: map[string]interface{}{
			"content_length": contentLength,
			"fetch_ms":       fetchDuration.Milliseconds(),
		},
	})

	log.Printf("Playing audio: url=%s, contentType=%s, contentLength=%d", req.AudioUrl, contentType, contentLength)

	// Route to appropriate decoder
	if strings.Contains(contentType, "audio/mpeg") || strings.HasSuffix(url, ".mp3") {
		lg.Debug("Decoding as MP3", logger.LogEntry{
			ContentType: contentType,
		})
		return s.playMP3(ctx, resp.Body, req, session, trackName, lg)
	} else if strings.Contains(contentType, "audio/wav") ||
		strings.Contains(contentType, "audio/x-wav") ||
		strings.Contains(contentType, "audio/wave") ||
		strings.HasSuffix(url, ".wav") {
		lg.Debug("Decoding as WAV", logger.LogEntry{
			ContentType: contentType,
		})
		return s.playWAV(ctx, resp.Body, req, session, trackName, lg)
	}

	lg.Error("Unsupported audio format", fmt.Errorf("unsupported: %s", contentType), logger.LogEntry{
		ContentType: contentType,
		AudioURL:    req.AudioUrl,
	})
	return 0, fmt.Errorf("unsupported audio format: %s", contentType)
}

// playMP3 decodes and plays MP3 audio
func (s *LiveKitBridgeService) playMP3(
	ctx context.Context,
	r io.Reader,
	req *pb.PlayAudioRequest,
	session *RoomSession,
	trackName string,
	lg *logger.ContextLogger,
) (int64, error) {
	decodeStart := time.Now()

	// Create MP3 decoder
	dec, err := mp3.NewDecoder(r)
	if err != nil {
		lg.Error("Failed to create MP3 decoder", err, logger.LogEntry{
			AudioURL: req.AudioUrl,
		})
		return 0, fmt.Errorf("MP3 decode error: %w", err)
	}

	srcSR := dec.SampleRate()
	if srcSR <= 0 {
		lg.Error("Invalid MP3 sample rate", fmt.Errorf("sample rate: %d", srcSR), logger.LogEntry{
			SampleRate: srcSR,
		})
		return 0, fmt.Errorf("invalid MP3 sample rate")
	}

	lg.Debug("MP3 decoder initialized", logger.LogEntry{
		SampleRate: srcSR,
		Extra: map[string]interface{}{
			"decode_init_ms": time.Since(decodeStart).Milliseconds(),
		},
	})

	const dstSR = 16000
	resampler := &resampleState{step: float64(srcSR) / float64(dstSR)}

	buf := make([]byte, 4096)
	var totalSamples int64
	var totalBytesRead int64
	var writeErrors int64
	startTime := time.Now()
	lastProgressLog := time.Now()

	for {
		// Check for cancellation
		select {
		case <-ctx.Done():
			lg.Warn("MP3 playback cancelled", logger.LogEntry{
				TotalSamples: totalSamples,
				BytesRead:    totalBytesRead,
				DurationMs:   time.Since(startTime).Milliseconds(),
			})
			return 0, ctx.Err()
		default:
		}

		n, err := dec.Read(buf)
		if n > 0 {
			totalBytesRead += int64(n)

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
					writeErrors++
					lg.Error("Failed to write audio to track", err, logger.LogEntry{
						TotalSamples: totalSamples,
						Extra: map[string]interface{}{
							"write_errors": writeErrors,
						},
					})
					return 0, fmt.Errorf("failed to write audio: %w", err)
				}

				totalSamples += int64(len(resampled))
			}

			// Log progress every 5 seconds
			if time.Since(lastProgressLog) > 5*time.Second {
				lg.Debug("MP3 playback progress", logger.LogEntry{
					TotalSamples: totalSamples,
					BytesRead:    totalBytesRead,
					DurationMs:   time.Since(startTime).Milliseconds(),
				})
				lastProgressLog = time.Now()
			}
		}

		if err != nil {
			if !errors.Is(err, io.EOF) {
				lg.Error("MP3 read error", err, logger.LogEntry{
					TotalSamples: totalSamples,
					BytesRead:    totalBytesRead,
				})
				return 0, fmt.Errorf("MP3 read error: %w", err)
			}
			break
		}
	}

	duration := time.Since(startTime).Milliseconds()

	lg.Info("MP3 playback complete", logger.LogEntry{
		TotalSamples: totalSamples,
		BytesRead:    totalBytesRead,
		DurationMs:   duration,
		SampleRate:   srcSR,
		Extra: map[string]interface{}{
			"target_sample_rate": dstSR,
			"resample_ratio":     float64(srcSR) / float64(dstSR),
		},
	})

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
	lg *logger.ContextLogger,
) (int64, error) {
	br := bufio.NewReader(r)

	// Parse RIFF header
	header := make([]byte, 12)
	if _, err := io.ReadFull(br, header); err != nil {
		lg.Error("Failed to read WAV header", err, logger.LogEntry{
			AudioURL: req.AudioUrl,
		})
		return 0, fmt.Errorf("failed to read WAV header: %w", err)
	}

	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		lg.Error("Invalid WAV file", fmt.Errorf("not a valid WAV file"), logger.LogEntry{
			AudioURL: req.AudioUrl,
			Extra: map[string]interface{}{
				"magic_bytes": string(header[0:4]),
			},
		})
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
			lg.Error("Failed to read WAV chunk header", err, logger.LogEntry{})
			return 0, fmt.Errorf("failed to read chunk header: %w", err)
		}

		chunkID := string(hdr[0:4])
		size := binary.LittleEndian.Uint32(hdr[4:8])

		if chunkID == "fmt " {
			buf := make([]byte, size)
			if _, err := io.ReadFull(br, buf); err != nil {
				lg.Error("Failed to read fmt chunk", err, logger.LogEntry{})
				return 0, fmt.Errorf("failed to read fmt chunk: %w", err)
			}

			// Consume padding byte if odd size
			if size%2 == 1 {
				br.ReadByte()
			}

			if size < 16 {
				lg.Error("WAV fmt chunk too short", fmt.Errorf("size: %d", size), logger.LogEntry{})
				return 0, fmt.Errorf("fmt chunk too short")
			}

			audioFormat := binary.LittleEndian.Uint16(buf[0:2])
			numChannels = binary.LittleEndian.Uint16(buf[2:4])
			sampleRate = binary.LittleEndian.Uint32(buf[4:8])
			bitsPerSample = binary.LittleEndian.Uint16(buf[14:16])

			if audioFormat != 1 {
				lg.Error("Unsupported WAV format", fmt.Errorf("format: %d (only PCM supported)", audioFormat), logger.LogEntry{
					Extra: map[string]interface{}{
						"audio_format": audioFormat,
					},
				})
				return 0, fmt.Errorf("only PCM WAV supported")
			}
			if bitsPerSample != 16 {
				lg.Error("Unsupported WAV bit depth", fmt.Errorf("bits: %d", bitsPerSample), logger.LogEntry{
					Extra: map[string]interface{}{
						"bits_per_sample": bitsPerSample,
					},
				})
				return 0, fmt.Errorf("only 16-bit WAV supported")
			}
			if numChannels != 1 && numChannels != 2 {
				lg.Error("Unsupported WAV channel count", fmt.Errorf("channels: %d", numChannels), logger.LogEntry{
					Channels: int(numChannels),
				})
				return 0, fmt.Errorf("only mono/stereo WAV supported")
			}

			lg.Debug("WAV format parsed", logger.LogEntry{
				SampleRate: int(sampleRate),
				Channels:   int(numChannels),
				Extra: map[string]interface{}{
					"bits_per_sample": bitsPerSample,
					"audio_format":    audioFormat,
				},
			})

			haveFmt = true

		} else if chunkID == "data" {
			dataBytes = size
			haveData = true
			lg.Debug("WAV data chunk found", logger.LogEntry{
				Extra: map[string]interface{}{
					"data_bytes": dataBytes,
				},
			})
			break
		} else {
			// Skip unknown chunk
			if _, err := io.CopyN(io.Discard, br, int64(size)); err != nil {
				lg.Error("Failed to skip WAV chunk", err, logger.LogEntry{
					Extra: map[string]interface{}{
						"chunk_id": chunkID,
					},
				})
				return 0, fmt.Errorf("failed to skip chunk: %w", err)
			}
			if size%2 == 1 {
				br.ReadByte()
			}
		}
	}

	if !haveFmt || !haveData {
		lg.Error("WAV missing required chunks", fmt.Errorf("haveFmt=%v, haveData=%v", haveFmt, haveData), logger.LogEntry{})
		return 0, fmt.Errorf("missing fmt or data chunk")
	}

	const dstSR = 16000
	resampler := &resampleState{step: float64(sampleRate) / float64(dstSR)}

	bytesPerFrame := int(bitsPerSample/8) * int(numChannels)
	if bytesPerFrame <= 0 {
		lg.Error("Invalid WAV frame size", fmt.Errorf("bytesPerFrame=%d", bytesPerFrame), logger.LogEntry{})
		return 0, fmt.Errorf("invalid frame size")
	}

	readLeft := int64(dataBytes)
	buf := make([]byte, 4096-(4096%bytesPerFrame))
	if len(buf) == 0 {
		buf = make([]byte, bytesPerFrame)
	}

	var totalSamples int64
	var totalBytesRead int64
	startTime := time.Now()
	lastProgressLog := time.Now()

	for readLeft > 0 {
		// Check for cancellation
		select {
		case <-ctx.Done():
			lg.Warn("WAV playback cancelled", logger.LogEntry{
				TotalSamples: totalSamples,
				BytesRead:    totalBytesRead,
				DurationMs:   time.Since(startTime).Milliseconds(),
			})
			return 0, ctx.Err()
		default:
		}

		toRead := int64(len(buf))
		if toRead > readLeft {
			toRead = readLeft
		}

		n, err := io.ReadFull(br, buf[:toRead])
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			lg.Error("Failed to read WAV audio data", err, logger.LogEntry{
				BytesRead: totalBytesRead,
			})
			return 0, fmt.Errorf("failed to read audio data: %w", err)
		}
		if n <= 0 {
			break
		}

		readLeft -= int64(n)
		totalBytesRead += int64(n)
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
				lg.Error("Failed to write WAV audio to track", err, logger.LogEntry{
					TotalSamples: totalSamples,
				})
				return 0, fmt.Errorf("failed to write audio: %w", err)
			}

			totalSamples += int64(len(output))
		}

		// Log progress every 5 seconds
		if time.Since(lastProgressLog) > 5*time.Second {
			lg.Debug("WAV playback progress", logger.LogEntry{
				TotalSamples: totalSamples,
				BytesRead:    totalBytesRead,
				DurationMs:   time.Since(startTime).Milliseconds(),
				Extra: map[string]interface{}{
					"bytes_remaining": readLeft,
				},
			})
			lastProgressLog = time.Now()
		}
	}

	duration := time.Since(startTime).Milliseconds()

	lg.Info("WAV playback complete", logger.LogEntry{
		TotalSamples: totalSamples,
		BytesRead:    totalBytesRead,
		DurationMs:   duration,
		SampleRate:   int(sampleRate),
		Channels:     int(numChannels),
		Extra: map[string]interface{}{
			"target_sample_rate": dstSR,
			"data_bytes":         dataBytes,
		},
	})

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
