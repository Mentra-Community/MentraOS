/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef AUDIO_UTIL_OGG_OPUS_ENCODER_H_
#define AUDIO_UTIL_OGG_OPUS_ENCODER_H_

#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "libogg/ogg.h"
#include "libopus/opus.h"

namespace audio_util {

// This class is meant to be a dependency-light streaming encoder.
//
// Encoding is done internally on a block size of 20ms, which seems to be the
// recommended size for Opus encoding.
class OggOpusEncoder {
 public:
  // Input is int16 data.
  constexpr static int kBytesPerSample = 2;
  constexpr static int kBitsPerSample = 16;

  // num_channels must be 1 or 2.
  // sample rate must be one of {8000, 12000, 16000, 24000, 48000}
  // Note that low_latency_mode will increase the total number of Ogg packets,
  // but will reduce overall latency of the codec. This does not impact the
  // quality of audio compression, only how the data is packaged in the Ogg
  // container. Low latency mode is only recommended for realtime streaming
  // applications. See test for actual bitrate increases.
  OggOpusEncoder(int num_channels, int sample_rate_hz, int bitrate_bps,
                 bool use_vbr, bool low_latency_mode);

  ~OggOpusEncoder();

  // Encodes 16-bit PCM data in OggOpus format. There is no restriction on the
  // size of the input vector.
  // Note that it is very common for the returned vector to be empty. Keep
  // calling this function with new samples until they become available.
  const std::vector<unsigned char>& Process(const std::vector<int16_t>& pcm);

  // Returns any remaining samples from the codec. This should be called last,
  // and never more than once.
  const std::vector<unsigned char>& Flush();

 private:
  using OpusUniquePtr =
      std::unique_ptr<OpusEncoder, decltype(&opus_encoder_destroy)>;

  std::string GetOpusErrorMessage() const;

  // Push the Opus header details into the ogg stream.
  void GenerateOggPacketsForHeader();

  // Push data from a single Opus frame into an Ogg stream.
  void GenerateOggPacketsForOpusFrame(unsigned char* opus_frame_bytes,
                                     int opus_bytes_length,
                                     std::vector<unsigned char>* ogg_bytes,
                                     bool flush);

  // Moves data from the stream_ object into buffer.
  void AppendOggStateToBuffer(std::vector<unsigned char>* buffer, bool flush);

  int num_channels_;
  int sample_rate_hz_;
  int bitrate_bps_;

  // Number of samples in an Opus 20ms frame for a single channel.
  int frame_size_;
  OpusUniquePtr encoder_;

  // Stores the status of Opus codec initialization.
  int error_code_;

  // Checks that Flush() isn't called multiple times.
  bool flushed_;
  bool header_;

  // When true, flushing of the Ogg stream after every call to Process().
  bool low_latency_mode_;

  // A preallocated buffer to store the temporary OGG result.
  std::vector<unsigned char> opus_frame_;

  std::vector<unsigned char> ogg_bytes_;

  // A stored buffer for a single frame of PCM data to be processed.
  int elements_in_pcm_frame_;
  std::vector<opus_int16> pcm_frame_;

  // Ogg objects.
  ogg_stream_state stream_;
  ogg_page page_;
  int packet_count_;      // Count of packets pushed to the stream.
  int granule_position_;  // Position in the ogg stream.
};

}  // namespace audio_util

#endif  // AUDIO_UTIL_OGG_OPUS_ENCODER_H_
