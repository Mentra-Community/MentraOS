/* Copyright 2000-2002, Michael Smith <msmith@xiph.org>
             2010, Monty <monty@xiph.org>
   AIFF/AIFC support from OggSquish, (c) 1994-1996 Monty <xiphmont@xiph.org>
   (From GPL code in oggenc relicensed by permission from Monty and Msmith)
   File: audio-in.c

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
# include <config.h>
#endif

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <math.h>

#ifdef WIN32
# include <malloc.h>
# include <windows.h> /*GetFileType()*/
# include <io.h>      /*_get_osfhandle()*/
#else
# ifdef HAVE_ALLOCA_H
#  include <alloca.h>
# else
#  include <stdlib.h>
# endif
#endif

#ifdef ENABLE_NLS
#include <libintl.h>
#define _(X) gettext(X)
#else
#define _(X) (X)
#define textdomain(X)
#define bindtextdomain(X, Y)
#endif
#ifdef gettext_noop
#define N_(X) gettext_noop(X)
#else
#define N_(X) (X)
#endif

#include <ogg/ogg.h>
#include "opusenc.h"
#include "speex_resampler.h"
#include "lpc.h"
#include "opus_header.h"

#ifdef HAVE_LIBFLAC
#include "flac.h"
#endif

/* Macros to read header data */
#define READ_U32_LE(buf) \
    (((buf)[3]<<24)|((buf)[2]<<16)|((buf)[1]<<8)|((buf)[0]&0xff))

#define READ_U16_LE(buf) \
    (((buf)[1]<<8)|((buf)[0]&0xff))

#define READ_U32_BE(buf) \
    (((buf)[0]<<24)|((buf)[1]<<16)|((buf)[2]<<8)|((buf)[3]&0xff))

#define READ_U16_BE(buf) \
    (((buf)[0]<<8)|((buf)[1]&0xff))

/* Define the supported formats here */
input_format formats[] = {
    {wav_id, 12, wav_open, wav_close, "wav", N_("WAV file reader")},
    {aiff_id, 12, aiff_open, wav_close, "aiff", N_("AIFF/AIFC file reader")},
#ifdef HAVE_LIBFLAC
    {flac_id,     4, flac_open, flac_close, "flac", N_("FLAC file reader")},
    {oggflac_id, 32, flac_open, flac_close, "ogg", N_("Ogg FLAC file reader")},
#endif
    {NULL, 0, NULL, NULL, NULL, NULL}
};

input_format *open_audio_file(FILE *in, oe_enc_opt *opt)
{
    int j=0;
    unsigned char *buf=NULL;
    int buf_size=0, buf_filled=0;
    int size,ret;

    while(formats[j].id_func)
    {
        size = formats[j].id_data_len;
        if(size >= buf_size)
        {
            buf = realloc(buf, size);
            buf_size = size;
        }

        if(size > buf_filled)
        {
            ret = fread(buf+buf_filled, 1, buf_size-buf_filled, in);
            buf_filled += ret;

            if(buf_filled < size)
            { /* File truncated */
                j++;
                continue;
            }
        }

        if(formats[j].id_func(buf, buf_filled))
        {
            /* ok, we now have something that can handle the file */
            if(formats[j].open_func(in, opt, buf, buf_filled)) {
                free(buf);
                return &formats[j];
            }
        }
        j++;
    }

    free(buf);

    return NULL;
}

static int seek_forward(FILE *in, unsigned int length)
{
    if(fseek(in, length, SEEK_CUR))
    {
        /* Failed. Do it the hard way. */
        unsigned char buf[1024];
        unsigned int seek_needed = length;
        int seeked;
        while(seek_needed > 0)
        {
            seeked = fread(buf, 1, seek_needed>1024?1024:seek_needed, in);
            if(!seeked)
                return 0; /* Couldn't read more, can't read file */
            else
                seek_needed -= seeked;
        }
    }
    return 1;
}

static int find_wav_chunk(FILE *in, char *type, unsigned int *len)
{
    unsigned char buf[8];

    while(1)
    {
        if(fread(buf,1,8,in) < 8) /* Suck down a chunk specifier */
        {
            fprintf(stderr, _("Warning: Unexpected EOF in reading WAV header\n"));
            return 0; /* EOF before reaching the appropriate chunk */
        }

        if(memcmp(buf, type, 4))
        {
            *len = READ_U32_LE(buf+4);
            if(!seek_forward(in, *len))
                return 0;

            buf[4] = 0;
            fprintf(stderr, _("Skipping chunk of type \"%s\", length %d\n"), buf, *len);
        }
        else
        {
            *len = READ_U32_LE(buf+4);
            return 1;
        }
    }
}

static int find_aiff_chunk(FILE *in, char *type, unsigned int *len)
{
    unsigned char buf[8];
    int restarted = 0;

    while(1)
    {
        if(fread(buf,1,8,in) <8)
        {
            if(!restarted) {
                /* Handle out of order chunks by seeking back to the start
                 * to retry */
                restarted = 1;
                fseek(in, 12, SEEK_SET);
                continue;
            }
            fprintf(stderr, _("Warning: Unexpected EOF in AIFF chunk\n"));
            return 0;
        }

        *len = READ_U32_BE(buf+4);

        if(memcmp(buf,type,4))
        {
            if((*len) & 0x1)
                (*len)++;

            if(!seek_forward(in, *len))
                return 0;
        }
        else
            return 1;
    }
}

double read_IEEE80(unsigned char *buf)
{
    int s=buf[0]&0xff;
    int e=((buf[0]&0x7f)<<8)|(buf[1]&0xff);
    double f=((unsigned long)(buf[2]&0xff)<<24)|
        ((buf[3]&0xff)<<16)|
        ((buf[4]&0xff)<<8) |
         (buf[5]&0xff);

    if(e==32767)
    {
        if(buf[2]&0x80)
            return HUGE_VAL; /* Really NaN, but this won't happen in reality */
        else
        {
            if(s)
                return -HUGE_VAL;
            else
                return HUGE_VAL;
        }
    }

    f=ldexp(f,32);
    f+= ((buf[6]&0xff)<<24)|
        ((buf[7]&0xff)<<16)|
        ((buf[8]&0xff)<<8) |
         (buf[9]&0xff);

    return ldexp(f, e-16446);
}

/* AIFF/AIFC support adapted from the old OggSQUISH application */
int aiff_id(unsigned char *buf, int len)
{
    if(len<12) return 0; /* Truncated file, probably */

    if(memcmp(buf, "FORM", 4))
        return 0;

    if(memcmp(buf+8, "AIF",3))
        return 0;

    if(buf[11]!='C' && buf[11]!='F')
        return 0;

    return 1;
}

static int aiff_permute_matrix[6][6] =
{
  {0},              /* 1.0 mono   */
  {0,1},            /* 2.0 stereo */
  {0,2,1},          /* 3.0 channel ('wide') stereo */
  {0,1,2,3},        /* 4.0 discrete quadraphonic (WARN) */
  {0,2,1,3,4},      /* 5.0 surround (WARN) */
  {0,1,2,3,4,5},    /* 5.1 surround (WARN)*/
};

int aiff_open(FILE *in, oe_enc_opt *opt, unsigned char *buf, int buflen)
{
    int aifc; /* AIFC or AIFF? */
    unsigned int len;
    unsigned char *buffer;
    unsigned char buf2[8];
    int bigendian = 1;
    aiff_fmt format;
    aifffile *aiff;
    int i;
    (void)buflen;/*unused*/

    if(buf[11]=='C')
        aifc=1;
    else
        aifc=0;

    if(!find_aiff_chunk(in, "COMM", &len))
    {
        fprintf(stderr, _("Warning: No common chunk found in AIFF file\n"));
        return 0; /* EOF before COMM chunk */
    }

    if(len < 18)
    {
        fprintf(stderr, _("Warning: Truncated common chunk in AIFF header\n"));
        return 0; /* Weird common chunk */
    }

    buffer = alloca(len);

    if(fread(buffer,1,len,in) < len)
    {
        fprintf(stderr, _("Warning: Unexpected EOF in reading AIFF header\n"));
        return 0;
    }

    format.channels = READ_U16_BE(buffer);
    format.totalframes = READ_U32_BE(buffer+2);
    format.samplesize = READ_U16_BE(buffer+6);
    format.rate = (int)read_IEEE80(buffer+8);

    if(aifc)
    {
        if(len < 22)
        {
            fprintf(stderr, _("Warning: AIFF-C header truncated.\n"));
            return 0;
        }

        if(!memcmp(buffer+18, "NONE", 4))
        {
            bigendian = 1;
        }
        else if(!memcmp(buffer+18, "sowt", 4))
        {
            bigendian = 0;
        }
        else
        {
            fprintf(stderr, _("Warning: Can't handle compressed AIFF-C (%c%c%c%c)\n"), *(buffer+18), *(buffer+19), *(buffer+20), *(buffer+21));
            return 0; /* Compressed. Can't handle */
        }
    }

    if(!find_aiff_chunk(in, "SSND", &len))
    {
        fprintf(stderr, _("Warning: No SSND chunk found in AIFF file\n"));
        return 0; /* No SSND chunk -> no actual audio */
    }

    if(len < 8)
    {
        fprintf(stderr, _("Warning: Corrupted SSND chunk in AIFF header\n"));
        return 0;
    }

    if(fread(buf2,1,8, in) < 8)
    {
        fprintf(stderr, _("Warning: Unexpected EOF reading AIFF header\n"));
        return 0;
    }

    format.offset = READ_U32_BE(buf2);
    format.blocksize = READ_U32_BE(buf2+4);

    if( format.blocksize == 0 &&
        (format.samplesize == 16 || format.samplesize == 8))
    {
        /* From here on, this is very similar to the wav code. Oh well. */

        opt->rate = format.rate;
        opt->channels = format.channels;
        opt->read_samples = wav_read; /* Similar enough, so we use the same */
        opt->total_samples_per_channel = format.totalframes;

        aiff = malloc(sizeof(aifffile));
        aiff->f = in;
        aiff->samplesread = 0;
        aiff->channels = format.channels;
        aiff->samplesize = format.samplesize;
        aiff->totalsamples = format.totalframes;
        aiff->bigendian = bigendian;

        if(aiff->channels>3)
          fprintf(stderr,"WARNING: AIFF[-C] files with greater than three channels use\n"
                  "speaker locations incompatable with Vorbis suppound definitions.\n"
                  "Not performaing channel location mapping.\n");

        opt->readdata = (void *)aiff;

        aiff->channel_permute = malloc(aiff->channels * sizeof(int));
        if (aiff->channels <= 6)
            /* Where we know the mappings, use them. */
            memcpy(aiff->channel_permute, aiff_permute_matrix[aiff->channels-1],
                    sizeof(int) * aiff->channels);
        else
            /* Use a default 1-1 mapping */
            for (i=0; i < aiff->channels; i++)
                aiff->channel_permute[i] = i;

        seek_forward(in, format.offset); /* Swallow some data */
        return 1;
    }
    else
    {
        fprintf(stderr,
                _("Warning: OggEnc does not support this type of AIFF/AIFC file\n"
                " Must be 8 or 16 bit PCM.\n"));
        return 0;
    }
}

int wav_id(unsigned char *buf, int len)
{
    if(len<12) return 0; /* Something screwed up */

    if(memcmp(buf, "RIFF", 4))
        return 0; /* Not wave */

    /*flen = READ_U32_LE(buf+4);*/ /* We don't use this */

    if(memcmp(buf+8, "WAVE",4))
        return 0; /* RIFF, but not wave */

    return 1;
}

int wav_open(FILE *in, oe_enc_opt *opt, unsigned char *oldbuf, int buflen)
{
    unsigned char buf[40];
    unsigned int len;
    int samplesize;
    wav_fmt format;
    wavfile *wav;
    int i;
    (void)buflen;/*unused*/
    (void)oldbuf;/*unused*/

    /* Ok. At this point, we know we have a WAV file. Now we have to detect
     * whether we support the subtype, and we have to find the actual data
     * We don't (for the wav reader) need to use the buffer we used to id this
     * as a wav file (oldbuf)
     */

    if(!find_wav_chunk(in, "fmt ", &len))
        return 0; /* EOF */

    if(len < 16)
    {
        fprintf(stderr, _("Warning: Unrecognised format chunk in WAV header\n"));
        return 0; /* Weird format chunk */
    }

    /* A common error is to have a format chunk that is not 16, 18 or
     * 40 bytes in size.  This is incorrect, but not fatal, so we only
     * warn about it instead of refusing to work with the file.
     * Please, if you have a program that's creating format chunks of
     * sizes other than 16 or 18 bytes in size, report a bug to the
     * author.
     */
    if(len!=16 && len!=18 && len!=40)
        fprintf(stderr,
                _("Warning: INVALID format chunk in wav header.\n"
                " Trying to read anyway (may not work)...\n"));

    if(len>40)len=40;

    if(fread(buf,1,len,in) < len)
    {
        fprintf(stderr, _("Warning: Unexpected EOF in reading WAV header\n"));
        return 0;
    }

    format.format =      READ_U16_LE(buf);
    format.channels =    READ_U16_LE(buf+2);
    format.samplerate =  READ_U32_LE(buf+4);
    format.bytespersec = READ_U32_LE(buf+8);
    format.align =       READ_U16_LE(buf+12);
    format.samplesize =  READ_U16_LE(buf+14);

    if(format.format == -2) /* WAVE_FORMAT_EXTENSIBLE */
    {
      if(len<40)
      {
        fprintf(stderr,"ERROR: Extended WAV format header invalid (too small)\n");
        return 0;
      }

      format.mask = READ_U32_LE(buf+20);
      /* warn the user if the format mask is not a supported/expected type */
      switch(format.mask){
      case 1539: /* 4.0 using side surround instead of back */
        fprintf(stderr,"WARNING: WAV file uses side surround instead of rear for quadraphonic;\n"
                "remapping side speakers to rear in encoding.\n");
        break;
      case 1551: /* 5.1 using side instead of rear */
        fprintf(stderr,"WARNING: WAV file uses side surround instead of rear for 5.1;\n"
                "remapping side speakers to rear in encoding.\n");
        break;
      case 319:  /* 6.1 using rear instead of side */
        fprintf(stderr,"WARNING: WAV file uses rear surround instead of side for 6.1;\n"
                "remapping rear speakers to side in encoding.\n");
        break;
      case 255:  /* 7.1 'Widescreen' */
        fprintf(stderr,"WARNING: WAV file is a 7.1 'Widescreen' channel mapping;\n"
                "remapping speakers to Vorbis 7.1 format.\n");
        break;
      case 0:    /* default/undeclared */
      case 1:    /* mono */
      case 3:    /* stereo */
      case 51:   /* quad */
      case 55:   /* 5.0 */
      case 63:   /* 5.1 */
      case 1807: /* 6.1 */
      case 1599: /* 7.1 */
        break;
      default:
        fprintf(stderr,"WARNING: Unknown WAV surround channel mask: %d\n"
                "blindly mapping speakers using default SMPTE/ITU ordering.\n",
                format.mask);
        break;
      }
      format.format = READ_U16_LE(buf+24);
    }

    if(!find_wav_chunk(in, "data", &len))
        return 0; /* EOF */

    if(format.format == 1)
    {
        samplesize = format.samplesize/8;
        opt->read_samples = wav_read;
    }
    else if(format.format == 3)
    {
        samplesize = 4;
        opt->read_samples = wav_ieee_read;
    }
    else
    {
        fprintf(stderr,
                _("ERROR: Wav file is unsupported type (must be standard PCM\n"
                " or type 3 floating point PCM\n"));
        return 0;
    }

    if(format.align != format.channels * samplesize) {
        /* This is incorrect according to the spec. Warn loudly, then ignore
         * this value.
         */
        fprintf(stderr, _("Warning: WAV 'block alignment' value is incorrect, "
                    "ignoring.\n"
                    "The software that created this file is incorrect.\n"));
    }

    if(format.samplesize == samplesize*8 &&
            (format.samplesize == 24 || format.samplesize == 16 ||
             format.samplesize == 8 ||
         (format.samplesize == 32 && format.format == 3)))
    {
        /* OK, good - we have the one supported format,
           now we want to find the size of the file */
        opt->rate = format.samplerate;
        opt->channels = format.channels;

        wav = malloc(sizeof(wavfile));
        wav->f = in;
        wav->samplesread = 0;
        wav->bigendian = 0;
        wav->channels = format.channels; /* This is in several places. The price
                                            of trying to abstract stuff. */
        wav->samplesize = format.samplesize;

        if(len>(format.channels*samplesize*4U) && len<((1U<<31)-65536) && opt->ignorelength!=1) /*Length provided is plausible.*/
        {
            opt->total_samples_per_channel = len/(format.channels*samplesize);
        }
#ifdef WIN32
        /*On Mingw/Win32 fseek() returns zero on pipes.*/
        else if (opt->ignorelength==1 || ((GetFileType((HANDLE)_get_osfhandle(fileno(in)))&~FILE_TYPE_REMOTE)!=FILE_TYPE_DISK))
#else
        else if (opt->ignorelength==1)
#endif
        {
           opt->total_samples_per_channel = 0;
        }
        else
        {
            opus_int64 pos;
            pos = ftell(in);
            if(fseek(in, 0, SEEK_END) == -1)
            {
                opt->total_samples_per_channel = 0; /* Give up */
            }
            else
            {
                opt->total_samples_per_channel = (ftell(in) - pos)/
                    (format.channels*samplesize);
                fseek(in,pos, SEEK_SET);
            }
        }
        wav->totalsamples = opt->total_samples_per_channel;

        opt->readdata = (void *)wav;

        wav->channel_permute = malloc(wav->channels * sizeof(int));
        if (wav->channels <= 8)
            /* Where we know the mappings, use them. */
            memcpy(wav->channel_permute, wav_permute_matrix[wav->channels-1],
                    sizeof(int) * wav->channels);
        else
            /* Use a default 1-1 mapping */
            for (i=0; i < wav->channels; i++)
                wav->channel_permute[i] = i;

        return 1;
    }
    else
    {
        fprintf(stderr,
                _("ERROR: Wav file is unsupported subformat (must be 8,16, or 24 bit PCM\n"
                "or floating point PCM\n"));
        return 0;
    }
}

long wav_read(void *in, float *buffer, int samples)
{
    wavfile *f = (wavfile *)in;
    int sampbyte = f->samplesize / 8;
    signed char *buf = alloca(samples*sampbyte*f->channels);
    long bytes_read = fread(buf, 1, samples*sampbyte*f->channels, f->f);
    int i,j;
    opus_int64 realsamples;
    int *ch_permute = f->channel_permute;

    if(f->totalsamples && f->samplesread +
            bytes_read/(sampbyte*f->channels) > f->totalsamples) {
        bytes_read = sampbyte*f->channels*(f->totalsamples - f->samplesread);
    }

    realsamples = bytes_read/(sampbyte*f->channels);
    f->samplesread += realsamples;

    if(f->samplesize==8)
    {
        unsigned char *bufu = (unsigned char *)buf;
        for(i = 0; i < realsamples; i++)
        {
            for(j=0; j < f->channels; j++)
            {
                buffer[i*f->channels+j]=((int)(bufu[i*f->channels + ch_permute[j]])-128)/128.0f;
            }
        }
    }
    else if(f->samplesize==16)
    {
        if(!f->bigendian)
        {
            for(i = 0; i < realsamples; i++)
            {
                for(j=0; j < f->channels; j++)
                {
                    buffer[i*f->channels+j] = ((buf[i*2*f->channels + 2*ch_permute[j] + 1]<<8) |
                                    (buf[i*2*f->channels + 2*ch_permute[j]] & 0xff))/32768.0f;
                }
            }
        }
        else
        {
            for(i = 0; i < realsamples; i++)
            {
                for(j=0; j < f->channels; j++)
                {
                    buffer[i*f->channels+j]=((buf[i*2*f->channels + 2*ch_permute[j]]<<8) |
                                  (buf[i*2*f->channels + 2*ch_permute[j] + 1] & 0xff))/32768.0f;
                }
            }
        }
    }
    else if(f->samplesize==24)
    {
        if(!f->bigendian) {
            for(i = 0; i < realsamples; i++)
            {
                for(j=0; j < f->channels; j++)
                {
                    buffer[i*f->channels+j] = ((buf[i*3*f->channels + 3*ch_permute[j] + 2] << 16) |
                      (((unsigned char *)buf)[i*3*f->channels + 3*ch_permute[j] + 1] << 8) |
                      (((unsigned char *)buf)[i*3*f->channels + 3*ch_permute[j]] & 0xff))
                        / 8388608.0f;

                }
            }
        }
        else {
            fprintf(stderr, _("Big endian 24 bit PCM data is not currently "
                              "supported, aborting.\n"));
            return 0;
        }
    }
    else {
        fprintf(stderr, _("Internal error: attempt to read unsupported "
                          "bitdepth %d\n"), f->samplesize);
        return 0;
    }

    return realsamples;
}

long wav_ieee_read(void *in, float *buffer, int samples)
{
    wavfile *f = (wavfile *)in;
    float *buf = alloca(samples*4*f->channels); /* de-interleave buffer */
    long bytes_read = fread(buf,1,samples*4*f->channels, f->f);
    int i,j;
    opus_int64 realsamples;

    if(f->totalsamples && f->samplesread +
            bytes_read/(4*f->channels) > f->totalsamples)
        bytes_read = 4*f->channels*(f->totalsamples - f->samplesread);

    realsamples = bytes_read/(4*f->channels);
    f->samplesread += realsamples;

    for(i=0; i < realsamples; i++)
        for(j=0; j < f->channels; j++)
            buffer[i*f->channels+j] = buf[i*f->channels + f->channel_permute[j]];

    return realsamples;
}

void wav_close(void *info)
{
    wavfile *f = (wavfile *)info;
    free(f->channel_permute);

    free(f);
}

int raw_open(FILE *in, oe_enc_opt *opt, unsigned char *buf, int buflen)
{
    wav_fmt format; /* fake wave header ;) */
    wavfile *wav = malloc(sizeof(wavfile));
    int i;
    (void)buf;/*unused*/
    (void)buflen;/*unused*/

    /* construct fake wav header ;) */
    format.format =      2;
    format.channels =    opt->channels;
    format.samplerate =  opt->rate;
    format.samplesize =  opt->samplesize;
    format.bytespersec = opt->channels * opt->rate * opt->samplesize / 8;
    format.align =       format.bytespersec;
    wav->f =             in;
    wav->samplesread =   0;
    wav->bigendian =     opt->endianness;
    wav->channels =      format.channels;
    wav->samplesize =    opt->samplesize;
    wav->totalsamples =  0;
    wav->channel_permute = malloc(wav->channels * sizeof(int));
    for (i=0; i < wav->channels; i++)
      wav->channel_permute[i] = i;

    opt->read_samples = wav_read;
    opt->readdata = (void *)wav;
    opt->total_samples_per_channel = 0; /* raw mode, don't bother */
    return 1;
}

typedef struct {
    audio_read_func real_reader;
    void *real_readdata;
    int channels;
    float scale_factor;
} scaler;

static long read_scaler(void *data, float *buffer, int samples) {
    scaler *d = data;
    long in_samples = d->real_reader(d->real_readdata, buffer, samples);
    int i;

    for(i=0; i < d->channels*in_samples; i++) {
       buffer[i] *= d->scale_factor;
    }

    return in_samples;
}

void setup_scaler(oe_enc_opt *opt, float scale) {
    scaler *d = calloc(1, sizeof(scaler));

    d->real_reader = opt->read_samples;
    d->real_readdata = opt->readdata;

    opt->read_samples = read_scaler;
    opt->readdata = d;
    d->channels = opt->channels;
    d->scale_factor = scale;
}

typedef struct {
    audio_read_func real_reader;
    void *real_readdata;
    ogg_int64_t *original_samples;
    int channels;
    int lpc_ptr;
    int *extra_samples;
    float *lpc_out;
} padder;

static long read_padder(void *data, float *buffer, int samples) {
    padder *d = data;
    long in_samples = d->real_reader(d->real_readdata, buffer, samples);
    int i, extra=0;
    const int lpc_order=32;

    if(d->original_samples)*d->original_samples+=in_samples;

    if(in_samples<samples){
      if(d->lpc_ptr<0){
        d->lpc_out=calloc(d->channels * *d->extra_samples, sizeof(*d->lpc_out));
        if(in_samples>lpc_order*2){
          float *lpc=alloca(lpc_order*sizeof(*lpc));
          for(i=0;i<d->channels;i++){
            vorbis_lpc_from_data(buffer+i,lpc,in_samples,lpc_order,d->channels);
            vorbis_lpc_predict(lpc,buffer+i+(in_samples-lpc_order)*d->channels,
                               lpc_order,d->lpc_out+i,*d->extra_samples,d->channels);
          }
        }
        d->lpc_ptr=0;
      }
      extra=samples-in_samples;
      if(extra>*d->extra_samples)extra=*d->extra_samples;
      *d->extra_samples-=extra;
    }
    memcpy(buffer+in_samples*d->channels,d->lpc_out+d->lpc_ptr*d->channels,extra*d->channels*sizeof(*buffer));
    d->lpc_ptr+=extra;
    return in_samples+extra;
}

void setup_padder(oe_enc_opt *opt,ogg_int64_t *original_samples) {
    padder *d = calloc(1, sizeof(padder));

    d->real_reader = opt->read_samples;
    d->real_readdata = opt->readdata;

    opt->read_samples = read_padder;
    opt->readdata = d;
    d->channels = opt->channels;
    d->extra_samples = &opt->extraout;
    d->original_samples=original_samples;
    d->lpc_ptr = -1;
    d->lpc_out = NULL;
}

void clear_padder(oe_enc_opt *opt) {
    padder *d = opt->readdata;

    opt->read_samples = d->real_reader;
    opt->readdata = d->real_readdata;

    if(d->lpc_out)free(d->lpc_out);
    free(d);
}

typedef struct {
    SpeexResamplerState *resampler;
    audio_read_func real_reader;
    void *real_readdata;
    float *bufs;
    int channels;
    int bufpos;
    int bufsize;
    int done;
} resampler;

static long read_resampled(void *d, float *buffer, int samples)
{
    resampler *rs = d;
    int out_samples=0;
    float *pcmbuf;
    int *inbuf;
    pcmbuf=rs->bufs;
    inbuf=&rs->bufpos;
    while(out_samples<samples){
      int i;
      int reading, ret;
      unsigned in_len, out_len;
      reading=1024-*inbuf;
      ret=rs->real_reader(rs->real_readdata, pcmbuf+*inbuf*rs->channels, reading);
      *inbuf+=ret;
      in_len=*inbuf;
      out_len=samples-out_samples;
      speex_resampler_process_interleaved_float(rs->resampler, pcmbuf, &in_len, buffer+out_samples*rs->channels, &out_len);
      if(ret==0&&in_len==0){
        for(i=out_samples*rs->channels;i<samples*rs->channels;i++)buffer[i]=0;
        return out_samples;
      }
      out_samples+=out_len;
      for(i=0;i<rs->channels*(*inbuf-(long int)in_len);i++)pcmbuf[i]=pcmbuf[i+rs->channels*in_len];
      *inbuf-=in_len;
    }
    return out_samples;
}

int setup_resample(oe_enc_opt *opt, int complexity, long outfreq) {
    resampler *rs = calloc(1, sizeof(resampler));
    int err;

    rs->bufsize = 2048; /* Shrug */
    rs->bufpos = 0;

    rs->real_reader = opt->read_samples;
    rs->real_readdata = opt->readdata;
    rs->channels = opt->channels;
    rs->done = 0;
    rs->resampler = speex_resampler_init(rs->channels, opt->rate, outfreq, complexity, &err);
    if(err!=0)fprintf(stderr, _("resampler error: %s\n"), speex_resampler_strerror(err));

    opt->skip+=speex_resampler_get_output_latency(rs->resampler);

    rs->bufs = malloc(sizeof(float) * rs->bufsize * opt->channels);

    opt->read_samples = read_resampled;
    opt->readdata = rs;
    if(opt->total_samples_per_channel)
        opt->total_samples_per_channel = (int)((float)opt->total_samples_per_channel *
            ((float)outfreq/(float)opt->rate));
    opt->rate = outfreq;

    return 0;
}

void clear_resample(oe_enc_opt *opt) {
    resampler *rs = opt->readdata;

    opt->read_samples = rs->real_reader;
    opt->readdata = rs->real_readdata;
    speex_resampler_destroy(rs->resampler);

    free(rs->bufs);

    free(rs);
}

typedef struct {
    audio_read_func real_reader;
    void *real_readdata;
    float *bufs;
    float *matrix;
    int in_channels;
    int out_channels;
} downmix;

static long read_downmix(void *data, float *buffer, int samples)
{
    downmix *d = data;
    long in_samples = d->real_reader(d->real_readdata, d->bufs, samples);
    int i,j,k,in_ch,out_ch;

    in_ch=d->in_channels;
    out_ch=d->out_channels;

    for(i=0;i<in_samples;i++){
      for(j=0;j<out_ch;j++){
        float *samp;
        samp=&buffer[i*out_ch+j];
        *samp=0;
        for(k=0;k<in_ch;k++){
          *samp+=d->bufs[i*in_ch+k]*d->matrix[in_ch*j+k];
        }
      }
    }
    return in_samples;
}

int setup_downmix(oe_enc_opt *opt, int out_channels) {
    static const float stupid_matrix[7][8][2]={
      /*2*/  {{1,0},{0,1}},
      /*3*/  {{1,0},{0.7071f,0.7071f},{0,1}},
      /*4*/  {{1,0},{0,1},{0.866f,0.5f},{0.5f,0.866f}},
      /*5*/  {{1,0},{0.7071f,0.7071f},{0,1},{0.866f,0.5f},{0.5f,0.866f}},
      /*6*/  {{1,0},{0.7071f,0.7071f},{0,1},{0.866f,0.5f},{0.5f,0.866f},{0.7071f,0.7071f}},
      /*7*/  {{1,0},{0.7071f,0.7071f},{0,1},{0.866f,0.5f},{0.5f,0.866f},{0.6123f,0.6123f},{0.7071f,0.7071f}},
      /*8*/  {{1,0},{0.7071f,0.7071f},{0,1},{0.866f,0.5f},{0.5f,0.866f},{0.866f,0.5f},{0.5f,0.866f},{0.7071f,0.7071f}},
    };
    float sum;
    downmix *d;
    int i,j;

    if(opt->channels<=out_channels || out_channels>2 || (out_channels==2&&opt->channels>8) || opt->channels<=0 || out_channels<=0) {
        fprintf(stderr, "Downmix must actually downmix and only knows mono/stereo out.\n");
        if(opt->channels>8)fprintf(stderr, "Downmix also only knows how to mix >8ch to mono.\n");
        return 0;
    }

    d = calloc(1, sizeof(downmix));
    d->bufs = malloc(sizeof(float)*opt->channels*4096);
    d->matrix = malloc(sizeof(float)*opt->channels*out_channels);
    d->real_reader = opt->read_samples;
    d->real_readdata = opt->readdata;
    d->in_channels=opt->channels;
    d->out_channels=out_channels;

    if(out_channels==1&&d->in_channels>8){
      for(i=0;i<d->in_channels;i++)d->matrix[i]=1.0f/d->in_channels;
    }else if(out_channels==2){
      for(j=0;j<d->out_channels;j++)
        for(i=0;i<d->in_channels;i++)d->matrix[d->in_channels*j+i]=
          stupid_matrix[opt->channels-2][i][j];
    }else{
      for(i=0;i<d->in_channels;i++)d->matrix[i]=
        (stupid_matrix[opt->channels-2][i][0])+
        (stupid_matrix[opt->channels-2][i][1]);
    }
    sum=0;
    for(i=0;i<d->in_channels*d->out_channels;i++)sum+=d->matrix[i];
    sum=(float)out_channels/sum;
    for(i=0;i<d->in_channels*d->out_channels;i++)d->matrix[i]*=sum;
    opt->read_samples = read_downmix;
    opt->readdata = d;

    opt->channels = out_channels;
    return out_channels;
}

void clear_downmix(oe_enc_opt *opt) {
    downmix *d = opt->readdata;

    opt->read_samples = d->real_reader;
    opt->readdata = d->real_readdata;
    opt->channels = d->in_channels; /* other things in cleanup rely on this */

    free(d->bufs);
    free(d->matrix);
    free(d);
}
