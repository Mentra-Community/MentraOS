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

#include "ogg_opus_encoder.h"

#include <cassert>
#include <endian.h>
#include <memory>
#include <string>
#include <cstdint>
#include "opus_tools/opus_header.h"

// Ogg Opus information comes from the standard here:
// https://tools.ietf.org/html/draft-ietf-codec-oggopus-14
// This was also a useful reference:
// https://github.com/krad-radio/butt-krad-opus/blob/302a4b6a6a596be6632f30cfb567a6a6d8fcb3f9/src/opus_encode.cpp

namespace audio_util {
namespace {

static constexpr float kEncodingBufferSizeSeconds = 0.02f;

std::string SerializeUint32(uint32_t value) {
  std::string result(4, '\0');
#if __BYTE_ORDER == __BIG_ENDIAN
#error The following line assumes that the byte order is little endian.
#endif
  memcpy(&result[0], &value, sizeof(value));
  return result;
}

}  // namespace

OggOpusEncoder::OggOpusEncoder(int num_channels, int sample_rate_hz,
                               int bitrate_bps, bool use_vbr,
                               bool low_latency_mode)
    : num_channels_(num_channels),
      sample_rate_hz_(sample_rate_hz),
      frame_size_(kEncodingBufferSizeSeconds * sample_rate_hz_),
      encoder_(OpusUniquePtr(
          opus_encoder_create(sample_rate_hz_, num_channels_,
                              OPUS_APPLICATION_AUDIO, &error_code_),
          opus_encoder_destroy)),
      flushed_(false),
      low_latency_mode_(low_latency_mode),
      elements_in_pcm_frame_(0),
      pcm_frame_(num_channels_ * frame_size_) {
  assert(num_channels <= 2);  // Only mono and stereo are supported).
  std::vector<int> valid_sample_rates = {8000, 12000, 16000, 24000, 48000};
  assert(std::find(valid_sample_rates.begin(), valid_sample_rates.end(),
                   sample_rate_hz) != valid_sample_rates.end());
  assert(bitrate_bps >= 500);
  assert(bitrate_bps <= 512000);

  opus_encoder_ctl(encoder_.get(), OPUS_SET_BITRATE(bitrate_bps));
  if (!use_vbr) {
    opus_encoder_ctl(encoder_.get(), OPUS_SET_VBR(0));
  }
  constexpr int kComplexity = 4;
  opus_encoder_ctl(encoder_.get(), OPUS_SET_COMPLEXITY(kComplexity));

  // We will always pass exactly one frame at a time to the encoder.
  opus_frame_.resize(kBytesPerSample * pcm_frame_.size());

  // Start generating Ogg packets (though they don't get sent out until the
  // first call to Encode()).
  packet_count_ = 0;
  granule_position_ = 0;
  ogg_stream_init(&stream_, 0 /* serial number */);
  GenerateOggPacketsForHeader();
}

OggOpusEncoder::~OggOpusEncoder() {
  ogg_stream_clear(&stream_);
}

// Encodes 16-bit PCM data in OggOpus format.
const std::vector<unsigned char>& OggOpusEncoder::Process(
    const std::vector<int16_t>& pcm) {
  assert(!flushed_);
  assert((pcm.size() % num_channels_) == 0);
  if (!header_) {
    ogg_bytes_.resize(0);
  } else {
    header_ = false;
  }
  int num_samples_processed = 0;

  // Process the first block, handling any leftovers from a previous round.
  if (elements_in_pcm_frame_ > 0) {
    int entries_to_write =
        std::min(pcm_frame_.size() - elements_in_pcm_frame_, pcm.size());
    std::copy(pcm.begin(), pcm.begin() + entries_to_write,
              pcm_frame_.begin() + elements_in_pcm_frame_);
    elements_in_pcm_frame_ += entries_to_write;
    if (elements_in_pcm_frame_ == pcm_frame_.size()) {
      // pcm_frame_ is full, encode it.
      int num_opus_frame_bytes =
          opus_encode(encoder_.get(), pcm_frame_.data(), frame_size_,
                      opus_frame_.data(), opus_frame_.size());

      assert(num_opus_frame_bytes >= 0);
      GenerateOggPacketsForOpusFrame(opus_frame_.data(), num_opus_frame_bytes,
                                     &ogg_bytes_, false);
      num_samples_processed += entries_to_write;
      pcm_frame_.assign(pcm_frame_.size(), 0);
      elements_in_pcm_frame_ = 0;
    } else {
      // There's nothing to encode. We've put all of pcm data into pcm_frame_
      // for later processing.
      ogg_bytes_.resize(0);
      return ogg_bytes_;
    }
  }

  // Process whole frames directly from pcm.
  while (num_samples_processed + frame_size_ * num_channels_ <= pcm.size()) {
    int num_opus_frame_bytes =
        opus_encode(encoder_.get(), pcm.data() + num_samples_processed,
                    frame_size_, opus_frame_.data(), opus_frame_.size());

    assert(num_opus_frame_bytes >= 0);
    GenerateOggPacketsForOpusFrame(opus_frame_.data(), num_opus_frame_bytes,
                                   &ogg_bytes_, false);
    num_samples_processed += frame_size_ * num_channels_;
  }

  if (low_latency_mode_) {
    // Force the codec to produce samples for every input buffer.
    AppendOggStateToBuffer(&ogg_bytes_, true);
  }

  // Place any remaining samples in pcm_frame_.
  elements_in_pcm_frame_ = pcm.size() - num_samples_processed;
  std::copy(pcm.begin() + num_samples_processed, pcm.end(), pcm_frame_.begin());
  return ogg_bytes_;
}

// Returns any remaining samples from the codec.
const std::vector<unsigned char>& OggOpusEncoder::Flush() {
  assert(!flushed_);
  ogg_bytes_.resize(0);
  int num_opus_frame_bytes =
      opus_encode(encoder_.get(), pcm_frame_.data(), frame_size_,
                  opus_frame_.data(), opus_frame_.size());
  assert(num_opus_frame_bytes >= 0);
  GenerateOggPacketsForOpusFrame(opus_frame_.data(), num_opus_frame_bytes,
                                 &ogg_bytes_, true);
  flushed_ = true;
  return ogg_bytes_;
}

void OggOpusEncoder::GenerateOggPacketsForHeader() {
  // Both header packets must have granule position of zero.
  assert(granule_position_ == 0);
  OpusHeader header;
  header.version = 1;
  header.channels = num_channels_;
  opus_encoder_ctl(encoder_.get(), OPUS_GET_LOOKAHEAD(&header.preskip));
  header.input_sample_rate = sample_rate_hz_;
  header.gain = 0;
  header.channel_mapping = 0;

  // Write the ID header.
  ogg_packet id_packet;
  id_packet.b_o_s = 1;  // The first packet.
  id_packet.e_o_s = 0;
  id_packet.granulepos = granule_position_;
  id_packet.packetno = packet_count_;
  constexpr int kHeaderSizeUpperBound = 64;
  id_packet.packet = new unsigned char[kHeaderSizeUpperBound];
  // opus_header_to_packet fills id_packet.packet with header data and returns
  // the number of bytes.
  id_packet.bytes =
      opus_header_to_packet(&header, id_packet.packet, kHeaderSizeUpperBound);
  // Add the ID packet into the stream.
  packet_count_++;
  ogg_stream_packetin(&stream_, &id_packet);

  // Write the comment header.
  ogg_packet comment_packet;
  comment_packet.b_o_s = 0;
  comment_packet.e_o_s = 0;
  comment_packet.granulepos = granule_position_;
  comment_packet.packetno = packet_count_;
  const std::string kVendor = "Google using libopus";
  std::string packet = "";
  packet.append("OpusTags");
  packet.append(SerializeUint32(kVendor.size()));
  packet.append(kVendor);
  packet.append(SerializeUint32(0));
  comment_packet.packet = const_cast<unsigned char*>(
      reinterpret_cast<const unsigned char*>(packet.c_str()));
  comment_packet.bytes = packet.length();

  // Add the comment header into the stream.
  packet_count_++;
  ogg_stream_packetin(&stream_, &comment_packet);
  // Force a page break after the comment header.
  // According to
  // https://tools.ietf.org/html/draft-ietf-codec-oggopus-14#section-3 there is
  // a mandatory page break after the comment header.
  AppendOggStateToBuffer(&ogg_bytes_, true);
  header_ = true;

  delete[] id_packet.packet;
}

void OggOpusEncoder::GenerateOggPacketsForOpusFrame(
    unsigned char* opus_frame_bytes, int opus_bytes_length,
    std::vector<unsigned char>* ogg_bytes, bool flush) {
  // Flush data from the ogg object into the outgoing stream.
  AppendOggStateToBuffer(ogg_bytes, flush);

  // Write the most recent buffer of Opus data into an Ogg packet.
  ogg_packet frame_packet;
  frame_packet.b_o_s = 0;
  frame_packet.e_o_s = flush ? 1 : 0;
  // According to
  // https://tools.ietf.org/html/draft-ietf-codec-oggopus-14#section-4 the
  // granule position should include all samples up to the last packet completed
  // on the page, so we need to update granule_position_ before assigning it to
  // the packet.  If we're closing the stream, we don't assume that the last
  // packet includes a full frame.
  if (flush) {
    granule_position_ += (elements_in_pcm_frame_ / num_channels_);
  } else {
    granule_position_ += frame_size_;
  }
  frame_packet.granulepos = granule_position_;
  frame_packet.packetno = packet_count_;
  frame_packet.packet = opus_frame_bytes;
  frame_packet.bytes = opus_bytes_length;
  // Add the data packet into the stream.
  packet_count_++;
  ogg_stream_packetin(&stream_, &frame_packet);

  // Try flushing again after data packet.
  AppendOggStateToBuffer(ogg_bytes, flush);
}

void OggOpusEncoder::AppendOggStateToBuffer(std::vector<unsigned char>* buffer,
                                            bool flush_ogg_stream) {
  int (*write_fun)(ogg_stream_state*, ogg_page*) =
      flush_ogg_stream ? &ogg_stream_flush : &ogg_stream_pageout;
  while (write_fun(&stream_, &page_) != 0) {
    const int initial_size = buffer->size();
    buffer->resize(buffer->size() + page_.header_len + page_.body_len);
    memcpy(buffer->data() + initial_size, page_.header, page_.header_len);
    memcpy(buffer->data() + initial_size + page_.header_len, page_.body,
           page_.body_len);
  }
}

}  // namespace audio_util
