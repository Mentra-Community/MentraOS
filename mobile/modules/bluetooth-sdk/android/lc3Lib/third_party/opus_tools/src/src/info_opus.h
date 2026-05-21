/* Copyright (C)2012 Gregory Maxwell
   File: info_opus.h

   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION OR
   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

typedef struct {
    OpusHeader  oh;
    ogg_int64_t bytes;
    ogg_int64_t overhead_bytes;
    ogg_int64_t lastlastgranulepos;
    ogg_int64_t lastgranulepos;
    ogg_int64_t firstgranule;
    ogg_int64_t total_samples;
    ogg_int64_t total_packets;
    ogg_int64_t total_pages;
    ogg_int32_t last_packet_duration;
    ogg_int32_t last_page_duration;
    ogg_int32_t max_page_duration;
    ogg_int32_t min_page_duration;
    ogg_int32_t max_packet_duration;
    ogg_int32_t min_packet_duration;
    ogg_int32_t max_packet_bytes;
    ogg_int32_t min_packet_bytes;
    int last_eos;

    int doneheaders;
} misc_opus_info;

void info_opus_start(stream_processor *stream);
