dnl Process this file with autoconf to produce a configure script. -*-m4-*-

AC_INIT(src/opusenc.c)

AM_CONFIG_HEADER([config.h])

dnl enable silent rules on automake 1.11 and later
m4_ifdef([AM_SILENT_RULES], [AM_SILENT_RULES([yes])])

OPUSTOOLS_MAJOR_VERSION=0
OPUSTOOLS_MINOR_VERSION=1
OPUSTOOLS_MICRO_VERSION=2
OPUSTOOLS_EXTRA_VERSION=git

OPUSTOOLS_VERSION="$OPUSTOOLS_MAJOR_VERSION.$OPUSTOOLS_MINOR_VERSION.$OPUSTOOLS_MICRO_VERSION$OPUSTOOLS_EXTRA_VERSION"
AC_MSG_CHECKING([git revision])
GIT_VERSION=$(git describe --tags --match 'v*' 2>/dev/null | sed 's/^v//')
if test -z "$GIT_VERSION"; then
  AC_MSG_RESULT([no])
else
  AC_MSG_RESULT([$GIT_VERSION])
  OPUSTOOLS_VERSION="$GIT_VERSION"
fi

# For automake.
VERSION=$OPUSTOOLS_VERSION
PACKAGE=opus-tools

AM_INIT_AUTOMAKE($PACKAGE, $VERSION)
AM_MAINTAINER_MODE

AC_CANONICAL_HOST
AM_PROG_CC_C_O

AC_PROG_CC_C99
AC_C_BIGENDIAN
AC_C_CONST
AC_C_INLINE

#Use a hacked up version of autoconf's AC_C_RESTRICT because it's not
#strong enough a test to detect old buggy versions of GCC (e.g. 2.95.3)
AC_CACHE_CHECK([for C/C++ restrict keyword], ac_cv_c_restrict,
  [ac_cv_c_restrict=no
   # The order here caters to the fact that C++ does not require restrict.
   for ac_kw in __restrict __restrict__ _Restrict restrict; do
     AC_COMPILE_IFELSE([AC_LANG_PROGRAM(
      [[typedef int * int_ptr;
	int foo (int_ptr $ac_kw ip, int * $ac_kw baz[]) {
	return ip[0];
       }]],
      [[int s[1];
	int * $ac_kw t = s;
	t[0] = 0;
	return foo(t, (void *)0)]])],
      [ac_cv_c_restrict=$ac_kw])
     test "$ac_cv_c_restrict" != no && break
   done
  ])
 AH_VERBATIM([restrict],
[/* Define to the equivalent of the C99 'restrict' keyword, or to
   nothing if this is not supported.  Do not define if restrict is
   supported directly.  */
#undef restrict
/* Work around a bug in Sun C++: it does not support _Restrict or
   __restrict__, even though the corresponding Sun C compiler ends up with
   "#define restrict _Restrict" or "#define restrict __restrict__" in the
   previous line.  Perhaps some future version of Sun C++ will work with
   restrict; if so, hopefully it defines __RESTRICT like Sun C does.  */
#if defined __SUNPRO_CC && !defined __RESTRICT
# define _Restrict
# define __restrict__
#endif])
 case $ac_cv_c_restrict in
   restrict) ;;
   no) AC_DEFINE([restrict], []) ;;
   *)  AC_DEFINE_UNQUOTED([restrict], [$ac_cv_c_restrict]) ;;
 esac

AC_MSG_CHECKING(for C99 variable-size arrays)
AC_TRY_COMPILE( [], [static int x; char a[++x]; a[sizeof a - 1] = 0; int N; return a[0];],
[has_var_arrays=yes;AC_DEFINE([VAR_ARRAYS], [], [Use C99 variable-size arrays])
],
has_var_arrays=no
)
AC_MSG_RESULT($has_var_arrays)

AC_CHECK_FUNC(exp,[fp_libm_not_needed=yes;LIBM=],[fp_libm_not_needed=dunno])
if test x"$fp_libm_not_needed" = xdunno; then
  AC_CHECK_LIB([m], [exp], [LIBS="-lm $LIBS"; LIBM="-lm"],[LIBM=])
fi
AC_SUBST([LIBM])

AC_CHECK_LIB(winmm, main)

AC_DEFINE_UNQUOTED(OPUSTOOLS_MAJOR_VERSION, ${OPUSTOOLS_MAJOR_VERSION}, [Version major])
AC_DEFINE_UNQUOTED(OPUSTOOLS_MINOR_VERSION, ${OPUSTOOLS_MINOR_VERSION}, [Version minor])
AC_DEFINE_UNQUOTED(OPUSTOOLS_MICRO_VERSION, ${OPUSTOOLS_MICRO_VERSION}, [Version micro])
AC_DEFINE_UNQUOTED(OPUSTOOLS_EXTRA_VERSION, "${OPUSTOOLS_EXTRA_VERSION}", [Version extra])

ac_enable_assertions="no"
AC_ARG_ENABLE(assertions, [  --enable-assertions     enable additional software error checking],
[if test "$enableval" = yes; then
  ac_enable_assertions="yes"
  AC_DEFINE([ENABLE_ASSERTIONS], , [Assertions])
fi])

dnl check for Ogg
HAVE_OGG=no

dnl first check through pkg-config since it's more flexible

dnl check for pkg-config itself so we don't try the m4 macro without pkg-config
AC_CHECK_PROG(HAVE_PKG_CONFIG, pkg-config, yes)
if test "x$HAVE_PKG_CONFIG" = "xyes"
then
  PKG_CHECK_MODULES(OGG, ogg >= 1.3, HAVE_OGG=yes, HAVE_OGG=no)
fi
if test "x$HAVE_OGG" = "xno"
then
  dnl fall back to the old school test
  XIPH_PATH_OGG(, AC_MSG_ERROR([
    libogg is required to build this package!
    please see http://www.xiph.org/ for how to
    obtain a copy.
  ]))
  cflags_save=$CFLAGS
  libs_save=$LIBS
  CFLAGS="$CFLAGS $OGG_CFLAGS"
  LIBS="$LIBS $OGG_LIBS"
  AC_CHECK_FUNC(ogg_stream_flush_fill, , [
    AC_MSG_ERROR([newer libogg version (1.3 or later) required])
  ])
  CFLAGS=$cflags_save
  LIBS=$libs_save
fi

dnl check for Opus
HAVE_OPUS=no

dnl first check through pkg-config since it's more flexible

dnl check for pkg-config itself so we don't try the m4 macro without pkg-config
AC_CHECK_PROG(HAVE_PKG_CONFIG, pkg-config, yes)
if test "x$HAVE_PKG_CONFIG" = "xyes"
then
  PKG_CHECK_MODULES(Opus, opus >= 0.9.10, HAVE_OPUS=yes, HAVE_OPUS=no)
fi
if test "x$HAVE_OPUS" = "xno"
then
  AC_MSG_ERROR([
    Opus is required to build this package!
    please see http://opus-codec.org/ for how to
    obtain a copy.])
fi

dnl check for OSS
HAVE_OSS=no
AC_CHECK_HEADERS([sys/soundcard.h soundcard.h machine/soundcard.h],[
  HAVE_OSS=yes
  break
])
if test x$HAVE_OSS != xyes; then
  AC_MSG_WARN([OSS audio support not found -- no direct audio output in opusdec])
fi

dnl OpenBSD needs -lossaudio to use the oss interface
OSS_LIBS=
case "$host_os" in
  openbsd*)
    OSS_LIBS='-lossaudio'
    ;;
esac
AC_SUBST(OSS_LIBS)


dnl Enable stack-protector-all only on x86 where it's well supported.
dnl on some platforms it causes crashes. Hopefully the OS's default's
dnl include this on platforms that work but have been missed here.

on_x86=no
case "$host_cpu" in
i[[3456]]86 | x86_64)
  on_x86=yes
  ;;
esac

use_stack_protector=no

if test $ac_cv_c_compiler_gnu = yes && test $on_x86 = yes; then
saved_CFLAGS="$CFLAGS"
CFLAGS="$CFLAGS -fstack-protector-all"
AC_MSG_CHECKING([if ${CC} supports -fstack-protector-all])
AC_LINK_IFELSE([AC_LANG_SOURCE([void main(void){char foo;}])],
      [ AC_MSG_RESULT([yes])
        STACK_PROTECTOR="-fstack-protector-all"; use_stack_protector=yes ],
        AC_MSG_RESULT([no]))
CFLAGS="$saved_CFLAGS $STACK_PROTECTOR"
fi

save_CFLAGS="$CFLAGS"
save_LDFLAGS="$LDFLAGS"
save_LIBS="$LIBS"
CFLAGS="$CFLAGS -fPIE $Opus_CFLAGS"
LDFLAGS="$LDFLAGS -pie -Wl,-z,relro -Wl,-z,now"
LIBS="$LIBS $Opus_LIBS"
AC_MSG_CHECKING([for PIE support])
AC_LINK_IFELSE([AC_LANG_SOURCE([
#include <opus.h>
void main () {
  OpusDecoder *dec = opus_decoder_create(48000, 2, 0L);
}])],
               [have_pie=yes],
               [have_pie=no])
AC_MSG_RESULT([$have_pie])
if test "x$have_pie" = "xyes"; then
    PIE_CFLAGS="-fPIE"
    PIE_LDFLAGS="-pie -Wl,-z,relro -Wl,-z,now"
fi
CFLAGS="$save_CFLAGS $PIE_CFLAGS"
LDFLAGS="$save_LDFLAGS $PIE_LDFLAGS"
LIBS="$save_LIBS"

CFLAGS="$CFLAGS -W"

saved_CFLAGS="$CFLAGS"
CFLAGS="$CFLAGS -Wall -Wextra -Wcast-align -Wnested-externs -Wshadow -Wstrict-prototypes"
AC_MSG_CHECKING([if ${CC} supports -Wall -Wextra -Wcast-align -Wnested-externs -Wshadow -Wstrict-prototypes])
AC_COMPILE_IFELSE([AC_LANG_SOURCE([char foo;])],
      [ AC_MSG_RESULT([yes])
        EXTRA_WARNS="-Wall -Wextra -Wcast-align -Wnested-externs -Wshadow -Wstrict-prototypes" ],
        AC_MSG_RESULT([no]))
CFLAGS="$saved_CFLAGS $EXTRA_WARNS"

AC_CHECK_FUNCS([lrintf])
AC_CHECK_FUNCS([lrint])
AC_CHECK_FUNCS([__malloc_hook])

AC_CHECK_SIZEOF(short)
AC_CHECK_SIZEOF(int)
AC_CHECK_SIZEOF(long)
AC_CHECK_SIZEOF(long long)

if test x$has_char16 = "xyes" ; then
        case 1 in
                $ac_cv_sizeof_short) SIZE16="short";;
                $ac_cv_sizeof_int) SIZE16="int";;
        esac
else
        case 2 in
                $ac_cv_sizeof_short) SIZE16="short";;
                $ac_cv_sizeof_int) SIZE16="int";;
        esac
fi

if test x$has_char16 = "xyes" ; then
        case 2 in
                $ac_cv_sizeof_int) SIZE32="int";;
                $ac_cv_sizeof_long) SIZE32="long";;
                $ac_cv_sizeof_short) SIZE32="short";;
        esac
else
        case 4 in
                $ac_cv_sizeof_int) SIZE32="int";;
                $ac_cv_sizeof_long) SIZE32="long";;
                $ac_cv_sizeof_short) SIZE32="short";;
        esac
fi

AC_SUBST(SIZE16)
AC_SUBST(SIZE32)

AC_OUTPUT([Makefile])

AC_MSG_RESULT([
------------------------------------------------------------------------
  $PACKAGE $VERSION:  Automatic configuration OK.

    Compiler support:

      C99 var arrays: ................ ${has_var_arrays}
      C99 lrintf: .................... ${ac_cv_func_lrintf}
      Stack protector: ............... ${use_stack_protector}
      PIE: ........................... ${have_pie}

    General configuration:

      Assertion checking: ............ ${ac_enable_assertions}

------------------------------------------------------------------------
])

echo "Type \"make; make install\" to compile and install";
echo "Type \"make check\" to run the test suite";
