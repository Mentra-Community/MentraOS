package main

import (
	"encoding/binary"
	"math"
)

// AudioResampler handles conversion between 16kHz and 48kHz
type AudioResampler struct {
	// Simple linear interpolation for upsampling
	// and decimation for downsampling
}

// Resample16to48 converts 16kHz PCM to 48kHz PCM
// Ratio is 3:1, so we need to interpolate 2 samples between each original sample
func Resample16to48(input []byte) []byte {
	// Linear interpolation (same as before) is acceptable for upsampling
	inputSamples := len(input) / 2
	outputSamples := inputSamples * 3
	output := make([]byte, outputSamples*2)
	for i := 0; i < inputSamples; i++ {
		sample := int16(binary.LittleEndian.Uint16(input[i*2 : i*2+2]))
		var nextSample int16
		if i < inputSamples-1 {
			nextSample = int16(binary.LittleEndian.Uint16(input[i*2+2 : i*2+4]))
		} else {
			nextSample = sample
		}
		binary.LittleEndian.PutUint16(output[i*6:i*6+2], uint16(sample))
		interp1 := sample + (nextSample-sample)/3
		interp2 := sample + (nextSample-sample)*2/3
		binary.LittleEndian.PutUint16(output[i*6+2:i*6+4], uint16(interp1))
		binary.LittleEndian.PutUint16(output[i*6+4:i*6+6], uint16(interp2))
	}
	return output
}

// Resample48to16 converts 48kHz PCM to 16kHz PCM
// Ratio is 3:1, so we take every 3rd sample
func Resample48to16(input []byte) []byte {
	// Apply a simple low-pass FIR (3-tap) then decimate by 3 to reduce aliasing
	// y[n] = (x[n-1] + 2*x[n] + x[n+1]) / 4; then take every 3rd sample
	inSamples := len(input) / 2
	if inSamples == 0 {
		return []byte{}
	}
	// Prepare int16 view
	x := make([]int16, inSamples)
	for i := 0; i < inSamples; i++ {
		x[i] = int16(binary.LittleEndian.Uint16(input[i*2 : i*2+2]))
	}
	outLen := inSamples / 3
	y := make([]int16, 0, outLen)
	for i := 0; i < inSamples; i += 3 {
		im1 := i - 1
		ip1 := i + 1
		if im1 < 0 {
			im1 = 0
		}
		if ip1 >= inSamples {
			ip1 = inSamples - 1
		}
		acc := int32(x[im1]) + 2*int32(x[i]) + int32(x[ip1])
		val := int16(acc / 4)
		y = append(y, val)
	}
	out := make([]byte, len(y)*2)
	for i := 0; i < len(y); i++ {
		binary.LittleEndian.PutUint16(out[i*2:i*2+2], uint16(y[i]))
	}
	return out
}

// ConvertPCMToOpus placeholder - in production would use opus encoder
func ConvertPCMToOpus(pcm []byte, sampleRate int) []byte { return pcm }

// ConvertOpusToPCM placeholder - in production would use opus decoder
func ConvertOpusToPCM(opus []byte, sampleRate int) []byte { return opus }

// NormalizePCM16 ensures audio levels are within safe range
func NormalizePCM16(input []byte) []byte {
	samples := len(input) / 2
	output := make([]byte, len(input))
	var peak int16
	for i := 0; i < samples; i++ {
		sample := int16(binary.LittleEndian.Uint16(input[i*2 : i*2+2]))
		if sample < 0 {
			sample = -sample
		}
		if sample > peak {
			peak = sample
		}
	}
	if peak < 1000 || peak >= 32767 {
		copy(output, input)
		return output
	}
	scale := float64(29490) / float64(peak)
	for i := 0; i < samples; i++ {
		sample := int16(binary.LittleEndian.Uint16(input[i*2 : i*2+2]))
		normalized := int16(math.Min(math.Max(float64(sample)*scale, -32768), 32767))
		binary.LittleEndian.PutUint16(output[i*2:i*2+2], uint16(normalized))
	}
	return output
}
