
#AUTOMAKE_OPTIONS = subdir-objects 1.6 dist-zip
AUTOMAKE_OPTIONS = subdir-objects 1.11 dist-zip dist-xz

SUBDIRS = .

INCLUDES = -I$(top_srcdir)/src

AM_CFLAGS = $(OGG_CFLAGS) $(Opus_CFLAGS) -DOPUSTOOLS -D_FORTIFY_SOURCE=2 -DHAVE_GETOPT_H -DSPX_RESAMPLE_EXPORT= -DRANDOM_PREFIX=opustools -DOUTSIDE_SPEEX -DFLOATING_POINT

bin_PROGRAMS = opusenc opusdec opusinfo

noinst_HEADERS = src/arch.h \
                 src/diag_range.h \
                 src/info_opus.h \
                 src/lpc.h \
                 src/opusenc.h \
                 src/opus_header.h \
                 src/opusinfo.h \
                 src/os_support.h \
                 src/speex_resampler.h \
                 src/stack_alloc.h \
                 src/wave_out.h \
                 src/wav_io.h

EXTRA_DIST = Makefile.unix

dist_man_MANS = man/opusenc.1 man/opusdec.1 man/opusinfo.1

opusenc_SOURCES = src/opus_header.c src/opusenc.c src/resample.c src/audio-in.c src/diag_range.c src/lpc.c
opusenc_LDADD = $(OGG_LIBS) $(Opus_LIBS) -lm
opusenc_MANS = man/opusenc.1

opusdec_SOURCES = src/opus_header.c src/wav_io.c src/wave_out.c src/opusdec.c src/resample.c src/diag_range.c
opusdec_LDADD = $(OGG_LIBS) $(Opus_LIBS) $(OSS_LIBS) -lm
opusdec_MANS = man/opusdec.1

opusinfo_SOURCES = src/opus_header.c src/opusinfo.c src/info_opus.c
opusinfo_LDADD = $(OGG_LIBS)
opusinfo_MANS = man/opusinfo.1

#TESTS = FIXME
