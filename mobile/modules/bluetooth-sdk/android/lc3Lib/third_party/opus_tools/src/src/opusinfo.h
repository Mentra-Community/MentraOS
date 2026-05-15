/* Ogginfo
 *
 * A tool to describe ogg file contents and metadata.
 *
 * Copyright 2002-2005 Michael Smith <msmith@xiph.org>
 * Licensed under the GNU GPL, distributed with this program.
 */

/*No NLS support for now*/
#define _(X) (X)

#ifdef _WIN32
#define I64FORMAT "I64d"
#else
#define I64FORMAT "lld"
#endif

typedef struct _stream_processor {
    void (*process_page)(struct _stream_processor *, ogg_page *);
    void (*process_end)(struct _stream_processor *);
    int isillegal;
    int constraint_violated;
    int shownillegal;
    int isnew;
    long seqno;
    int lostseq;

    int start;
    int end;

    int num;
    char *type;

    ogg_uint32_t serial; /* must be 32 bit unsigned */
    ogg_stream_state os;
    void *data;
} stream_processor;

typedef struct {
    stream_processor *streams;
    int allocated;
    int used;

    int in_headers;
} stream_set;


void oi_info(char *format, ...);
void oi_warn(char *format, ...);
void oi_error(char *format, ...);
void check_xiph_comment(stream_processor *stream, int i, const char *comment, int comment_length);
