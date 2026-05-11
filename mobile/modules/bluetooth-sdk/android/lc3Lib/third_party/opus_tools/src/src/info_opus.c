/* Copyright (C)2012 Gregory Maxwell
   File: info_opus.c

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

#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <stdlib.h>
#include <string.h>

#include <ogg/ogg.h>

#ifndef OPUSTOOLS
# include "ogginfo2.h"
#else
# include "opusinfo.h"
#endif
#include "opus_header.h"
#include "info_opus.h"

/* From libopus, src/opus_decode.c */
static int packet_get_samples_per_frame(const unsigned char *data, ogg_int32_t Fs)
{
   int audiosize;
   if (data[0]&0x80)
   {
      audiosize = ((data[0]>>3)&0x3);
      audiosize = (Fs<<audiosize)/400;
   } else if ((data[0]&0x60) == 0x60)
   {
      audiosize = (data[0]&0x08) ? Fs/50 : Fs/100;
   } else {
      audiosize = ((data[0]>>3)&0x3);
      if (audiosize == 3)
         audiosize = Fs*60/1000;
      else
         audiosize = (Fs<<audiosize)/100;
   }
   return audiosize;
}

/* From libopus, src/opus_decode.c */
static int packet_get_nb_frames(const unsigned char packet[], ogg_int32_t len)
{
   int count;
   if (len<1)
      return -1;
   count = packet[0]&0x3;
   if (count==0)
      return 1;
   else if (count!=3)
      return 2;
   else if (len<2)
      return -4;
   else
      return packet[1]&0x3F;
}

#define readle32(buf, base) (((buf[base+3]<<24)&0xff000000)| \
                             ((buf[base+2]<<16)&0xff0000)| \
                             ((buf[base+1]<<8)&0xff00)| \
                              (buf[base]&0xff))

void info_opus_process(stream_processor *stream, ogg_page *page )
{
    ogg_packet packet;
    ogg_int64_t page_samples=0;
    misc_opus_info *inf = stream->data;
    int header=0, packets=0;
    int res;

    ogg_stream_pagein(&stream->os, page);
    if(inf->doneheaders < 2)
        header = 1;
    inf->last_eos = ogg_page_eos(page);

    while(1) {
        ogg_int32_t spp;
        res = ogg_stream_packetout(&stream->os, &packet);
        if(res < 0) {
           oi_warn(_("WARNING: discontinuity in stream (%d)\n"), stream->num);
           continue;
        }
        else if (res == 0)
            break;

        packets++;
        if(inf->doneheaders < 2) {
            if(inf->doneheaders==0 && opus_header_parse(packet.packet,packet.bytes,&inf->oh)!=1) {
                oi_warn(_("WARNING: Could not decode Opus header "
                       "packet %d - invalid Opus stream (%d)\n"),
                        inf->doneheaders, stream->num);
                continue;
            } else if (inf->doneheaders==0){
                if(inf->oh.preskip<120)oi_warn(_("WARNING: Implausibly low preskip in Opus stream (%d)\n"),stream->num);
            }
            if(inf->doneheaders==1 && (packet.bytes<8 || memcmp(packet.packet, "OpusTags",8)!=0)) {
               oi_warn(_("WARNING: Could not decode OpusTags header "
                       "packet %d - invalid Opus stream (%d)\n"),
                        inf->doneheaders, stream->num);
                continue;
            } else if (inf->doneheaders==1) {
                char *tmp;
                char *c=(char *)packet.packet;
                int length, len, i, nb_fields;

                length=packet.bytes;
                if (length<(8+4+4)) {
                    oi_warn(_("Invalid/corrupted comments in stream %d\n"),stream->num);
                    continue;
                }
                c += 8;
                len=readle32(c, 0);
                c+=4;
                if (len < 0 || len>(length-16)) {
                    oi_warn(_("Invalid/corrupted comments in stream %d\n"),stream->num);
                    continue;
                }
                tmp=calloc(len+1,1);
                memcpy(tmp,c,len);
                oi_info(_("Encoded with %s\n"),tmp);
                free(tmp);
                c+=len;
                /*The -16 check above makes sure we can read this.*/
                nb_fields=readle32(c, 0);
                c+=4;
                length-=16+len;
                if (nb_fields < 0 || nb_fields>(length>>2)) {
                    oi_warn(_("Invalid/corrupted comments in stream %d\n"),stream->num);
                    continue;
                }
                if(nb_fields)oi_info(_("User comments section follows...\n"));
                for (i=0;i<nb_fields;i++) {
                    char *comment;
                    if (length<4) {
                        oi_warn(_("Invalid/corrupted comments in stream %d\n"),stream->num);
                        break;
                    }
                    len=readle32(c, 0);
                    c+=4;
                    length-=4;
                    if (len < 0 || len>length) {
                        oi_warn(_("Invalid/corrupted comments in stream %d\n"),stream->num);
                        break;
                    }
                    /*check_xiph_comment expects a null terminated comment*/
                    comment=malloc((len+1)*sizeof(char));
                    memcpy(comment,c,len);
                    comment[len]=0;
                    check_xiph_comment(stream, i, comment, len);
                    free(comment);
                    c+=len;
                    length-=len;
                }
            }

            inf->doneheaders++;
            continue;
        }
        if(packet.bytes>=2 && memcmp(packet.packet, "Op",2)==0) {
            oi_warn(_("WARNING: Invalid packet or misplaced header in stream %d\n"),stream->num);
            continue;
        }
        if(packet.bytes<1) {
            oi_warn(_("WARNING: Invalid zero byte packet in stream %d\n"),stream->num);
            continue;
        }
        spp = packet_get_nb_frames(packet.packet,packet.bytes);
        if(spp<1 || spp>48) {
            oi_warn(_("WARNING: Invalid packet TOC in stream %d\n"),stream->num);
            continue;
        }
        spp *= packet_get_samples_per_frame(packet.packet,48000);
        if(spp<120 || spp>5760 || (spp%120)!=0) {
            oi_warn(_("WARNING: Invalid packet TOC in stream %d\n"),stream->num);
            continue;
        }
        inf->total_samples += spp;
        page_samples += spp;
        inf->total_packets++;
        inf->last_packet_duration = spp;
        if(inf->max_packet_duration<spp)inf->max_packet_duration=spp;
        if(inf->min_packet_duration>spp)inf->min_packet_duration=spp;
        if(inf->max_packet_bytes<packet.bytes)inf->max_packet_bytes=packet.bytes;
        if(inf->min_packet_bytes>packet.bytes)inf->min_packet_bytes=packet.bytes;
    }

    if(!header) {
        ogg_int64_t gp = ogg_page_granulepos(page);
        if(gp > 0) {
            if(gp < inf->lastgranulepos)
                oi_warn(_("WARNING: granulepos in stream %d decreases from %"
                        I64FORMAT " to %" I64FORMAT "\n" ),
                        stream->num, inf->lastgranulepos, gp);
            if(inf->lastgranulepos==0 && inf->firstgranule==-1) {
                /*First timed page, now we can recover the start time.*/
                inf->firstgranule = gp-inf->total_samples;
                if(inf->firstgranule<0) {
                  /*There shouldn't be any negative samples after counting the samples in the page backwards
                    from the first GP, but if this is the last page of the stream there may need to be to trim.*/
                  if(!ogg_page_eos(page))oi_warn(_("WARNING: Samples with negative granpos in stream %d\n"),stream->num);
                  else inf->firstgranule=0;
                }
            }
            if(inf->total_samples<gp-inf->firstgranule)oi_warn(_("WARNING: Sample count behind granule (%" I64FORMAT ">%" I64FORMAT ") in stream %d\n"),
                (long long)inf->total_samples,(long long)(gp-inf->firstgranule),stream->num);
            if(!ogg_page_eos(page) && (inf->total_samples>gp-inf->firstgranule))
                oi_warn(_("WARNING: Sample count ahead of granule (%" I64FORMAT ">%" I64FORMAT ") in stream %d\n"),
                (long long)inf->total_samples,(long long)(gp-inf->firstgranule),stream->num);
            inf->lastlastgranulepos = inf->lastgranulepos;
            inf->lastgranulepos = gp;
            if(!packets)
                oi_warn(_("WARNING: Page with positive granpos (%" I64FORMAT ") on a page with no completed packets in stream %d\n"),gp,stream->num);
        }
        else if(packets) {
            /* Only do this if we saw at least one packet ending on this page.
             * It's legal (though very unusual) to have no packets in a page at
             * all - this is occasionally used to have an empty EOS page */
            oi_warn(_("Negative or zero granulepos (%" I64FORMAT ") on Opus stream outside of headers. This file was created by a buggy encoder\n"), gp);
        }
        inf->overhead_bytes += page->header_len;
        if(page_samples)inf->last_page_duration = page_samples;
        if(inf->max_page_duration<page_samples)inf->max_page_duration=page_samples;
        if(inf->min_page_duration>page_samples)inf->min_page_duration=page_samples;
        inf->total_pages++;
    } else {
        /* Headers and metadata are pure overhead. */
        inf->overhead_bytes += page->header_len + page->body_len;
    }
    inf->bytes += page->header_len + page->body_len;
}

void info_opus_end(stream_processor *stream)
{
    misc_opus_info *inf = stream->data;

    oi_info(_("Opus stream %d:\n"),stream->num);

    if(inf && inf->total_packets>0){
        int i;
        long minutes, seconds, milliseconds;
        double time;
        time = (inf->lastgranulepos-inf->firstgranule-inf->oh.preskip) / 48000.;
        if(time<=0)time=0;
        minutes = (long)(time) / 60;
        seconds = (long)(time - minutes*60);
        milliseconds = (long)((time - minutes*60 - seconds)*1000);
        if(inf->lastgranulepos-inf->firstgranule<inf->oh.preskip)
           oi_error(_("\tERROR: stream %d has a negative duration: %" I64FORMAT "-%" I64FORMAT "-%d=%" I64FORMAT "\n"),stream->num,
           inf->lastgranulepos,inf->firstgranule,inf->oh.preskip,inf->lastgranulepos-inf->firstgranule-inf->oh.preskip);
        if((inf->total_samples-inf->last_page_duration)>(inf->lastgranulepos-inf->firstgranule))
           oi_error(_("\tERROR: stream %d has interior holes or more than one page of end trimming\n"),stream->num);
        if(inf->last_eos &&( (inf->last_page_duration-inf->last_packet_duration)>(inf->lastgranulepos-inf->lastlastgranulepos)))
           oi_warn(_("\tWARNING: stream %d has more than one packet of end trimming\n"),stream->num);
        if(inf->max_page_duration>=240000)
           oi_warn(_("\tWARNING: stream %d has high muxing delay\n"),stream->num);
        oi_info(_("\tPre-skip: %d\n"),inf->oh.preskip);
        oi_info(_("\tPlayback gain: %gdB\n"),inf->oh.gain/256.);
        oi_info(_("\tChannels: %d\n"),inf->oh.channels);
        if(inf->oh.input_sample_rate)oi_info(_("\tOriginal sample rate: %dHz\n"),inf->oh.input_sample_rate);
        if(inf->oh.nb_streams>1)oi_info(_("\tStreams: %d, Coupled: %d\n"),inf->oh.nb_streams,inf->oh.nb_coupled);
        if(inf->oh.channel_mapping>0) {
          oi_info(_("\tChannel Mapping family: %d Map:"),inf->oh.channel_mapping);
          for(i=0;i<inf->oh.channels;i++)oi_info("%s%d%s",i==0?" [":", ",inf->oh.stream_map[i],i==inf->oh.channels-1?"]\n":"");
        }
        if(inf->total_packets)oi_info(_("\tPacket duration: %6.1fms (max), %6.1fms (avg), %6.1fms (min)\n"),
            inf->max_packet_duration/48.,inf->total_samples/(double)inf->total_packets/48.,inf->min_packet_duration/48.);
        if(inf->total_pages)oi_info(_("\tPage duration: %8.1fms (max), %6.1fms (avg), %6.1fms (min)\n"),
            inf->max_page_duration/48.,inf->total_samples/(double)inf->total_pages/48.,inf->min_page_duration/48.);
        oi_info(_("\tTotal data length: %" I64FORMAT " bytes (overhead: %0.3g%%)\n"),inf->bytes,(double)inf->overhead_bytes/inf->bytes*100.);
        oi_info(_("\tPlayback length: %ldm:%02ld.%03lds\n"), minutes, seconds, milliseconds);
        oi_info(_("\tAverage bitrate: %0.4g kb/s, w/o overhead: %.04g kb/s%s\n"),time<=0?0:inf->bytes*8/time/1000.0,
            time<=0?0:(inf->bytes-inf->overhead_bytes)*8/time/1000.0,
            (inf->min_packet_duration==inf->max_packet_duration)&&(inf->min_packet_bytes==inf->max_packet_bytes)?" (hard-CBR)":"");
    } else {
      oi_warn(_("\tWARNING: stream %d is empty\n"),stream->num);
    }
    free(stream->data);
}

void info_opus_start(stream_processor *stream)
{
    misc_opus_info *oinfo;

    stream->type = "opus";
    stream->process_page = info_opus_process;
    stream->process_end = info_opus_end;

    stream->data = calloc(1, sizeof(misc_opus_info));

    oinfo = stream->data;
    oinfo->firstgranule=-1;
    oinfo->min_packet_duration=5760;
    oinfo->min_page_duration=5760*255;
    oinfo->min_packet_bytes=2147483647;
}
