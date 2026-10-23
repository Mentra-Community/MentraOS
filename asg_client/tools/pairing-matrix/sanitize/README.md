# BES trace sanitizer

Makes a raw Mentra Live BES UART trace safe to share. The raw trace can hold
Bluetooth key material (see the finding below), so it stays on the machine that
captured it. Only the sanitized copy leaves.

```bash
python3 asg_client/tools/pairing-matrix/sanitize/sanitize_bes_trace.py raw.txt -o clean.txt --check
```

`sanitize_bes_trace.py INPUT [-o OUTPUT] [--check]`, Python 3, standard library only.

- Without `-o` the sanitized text goes to stdout.
- A summary of redaction counts (never content) goes to stderr.
- `--check` re-reads `OUTPUT` and exits `1` if any run of 8 or more hex bytes is
  left. It then deletes `OUTPUT`, so an unsafe file does not linger. With `--check`
  and no `-o`, nothing is written and `INPUT` itself is checked, which validates a
  file that was sanitized earlier.
- It refuses to overwrite `INPUT`. Exit codes: `0` ok, `1` residual run, `2`
  usage or I/O error.

## What it redacts

Every run of 8 or more consecutive hex bytes becomes `[REDACTED nN bytes]`, for
example `[REDACTED n16 bytes]`. A run is bytes separated by spaces, colons, dashes
or commas, optionally `0x`-prefixed (`00 11 22`, `00:11:22`, `0x00 0x11`), or 16
or more contiguous hex digits.

1. Lines with a key label (case-insensitive: `tmpLinkKey`, `tmpLtk`, `ltk`, `irk`,
   `linkKey`, `link key`, `randnb`, `rand`, `ediv`, `save link key`, `CTKD`) and the
   hex-dump lines that follow them. `DUMP8` prints one dump per line, so a
   key can span several lines. In that key context a hex-only continuation line
   is redacted whole, including fragments shorter than 8 bytes, unless it is
   exactly 6 bytes (an address). The context ends at the first non-hex line.
2. Every other line, so a key printed under an unexpected label is still removed.

6-byte runs stay visible. Address correlation (BLE identity versus Classic peer)
is the evidence the baseline needs. Addresses are still sensitive-ish: they
identify the glasses and the phone. Share a sanitized trace only in tickets that
already contain those addresses.

Limits, so nobody over-trusts it: it matches hex bytes, not meaning. A key that
a print statement splits into pieces under 8 bytes on a line that has no key label
and follows no key-label line would survive, and so would a key printed as decimal
or in a non-hex encoding. A short residual fragment in key context that happens to
be exactly 6 bytes is kept as an address. Read the sanitized file once before it
goes anywhere. The firmware fix (W4a, do not print keys at all) is the real
control.

## Finding: does the shipped image print key material over UART?

**Conclusion: live. The shipped build prints raw LTK, IRK and Classic link key
bytes through `DUMP8`.** Not `no-op`, and not `cannot tell` for the config. One
caveat is at the end.

Evidence (BES repo `/Users/mentra/Documents/mentra-live-bes`, HEAD `3ae31be5`):

1. `./build_pz.sh` and `./build_pz.sh OTA` compile with the same command,
   `make T=best1502x_ibrt_bpone REL_BUILD=1 -j8` (`build_pz.sh:66`). `OTA` only
   adds the LZMA step and the size/CRC gates afterwards (`build_pz.sh:29`,
   `:87`). `scripts/ci-build.sh:72` uses the same `make` line.
2. `REL_BUILD` is not read by any makefile in the repo (it appears only in those
   three command lines and the README), so it changes nothing.
3. `config/best1502x_ibrt_bpone/basic_target.mk:3` sets `DEBUG ?= 1`, included
   from `config/best1502x_ibrt_bpone/target.mk:197`. Neither `build_pz.sh` nor
   `ci-build.sh` passes `DEBUG=`. So `DEBUG` is 1 for the release target.
4. `config/common.mk:1131-1133` adds `-DDEBUG` when `DEBUG=1`. The branch that adds
   `-DREL_TRACE_ENABLE` is the `else # !DEBUG` branch (`common.mk:1140-1149`), so
   it is skipped. `DEBUG` is defined and `REL_TRACE_ENABLE` is not.
5. `NO_TRACE` is not defined anywhere (no makefile, no header, no script).
   `NO_REL_TRACE` is defined only under a commented-out `INTERSYS_RAW_DATA_ONLY`
   (`platform/hal/hal_trace.h:30-33`).
6. `platform/hal/hal_trace.h:104`: `DUMP8` is a no-op only when
   `!defined(DEBUG) && defined(REL_TRACE_ENABLE) && !defined(NO_TRACE)`. With
   `DEBUG` defined that is false, so `DUMP8` is `REL_DUMP8` (`:120`). `REL_DUMP8`
   is `hal_trace_dump(...)` under `(DEBUG || REL_TRACE_ENABLE) && !NO_REL_TRACE`
   (`:80`, `:89`), which holds here.
7. Build artifacts confirm it (existing `out/best1502x_ibrt_bpone/`, not rebuilt for
   this check): `nvrecord_ble.o` has an undefined reference to `hal_trace_dump`,
   and the ELF holds the labels `NV LTK:`, `peer irk`, `tmpLtk:` and `tmpLinkKey:`.

Key-material `DUMP8` calls this reaches (line numbers in the current tree):
`nvrecord_ble.c` LTK 385, 482, 921, IRK 387 and 798/836, random 383, derived Classic
link key 890 and 940 (`link_key_req`); `app_sec.c` LTK and link key 174, 187, 637,
909, random 640 and 912, IRK 861.

Runtime: the trace is live on shipped glasses. `docs/uart-log-budget.md` in the
BES repo measures the ring at about 4.4 KB/s from them, and the pairing-matrix
harness reads it (`bes_trace` in `pmx.py`). A reader can therefore see the key
bytes whenever one of these calls runs, for example during a pair.

Caveat: this is a source and build-config proof. It was not checked against the
published 17.26.7.28 binary itself. Verifying that needs that binary's ELF or a
live capture, and a capture is exactly the file the rules above keep local. The
key-logging gate (W4a) ships regardless, and `runs/` is untracked but **not**
git-ignored (only `*.log` files are): add by explicit path, never `git add .` over
`asg_client/tools/pairing-matrix`.

## Tests

Synthetic bytes only. From `asg_client/tools/pairing-matrix`:

```bash
python3 -m unittest discover -s sanitize -p 'test_*.py'
```
