# G1 character support

The stock G1 **1.5.6** application image contains an embedded font index with
**445 records / 413 unique code points**, including **124 extended Latin
letters**. The full extracted index, with raw glyph widths, is in
[g1-embedded-glyphs.csv](g1-embedded-glyphs.csv). `Å` (U+00C5, width 6) and `å`
(U+00E5, width 5) are present. The display advance is `(glyphWidth + 1) * 2`.

## Evidence and reproduction

- [Stock 1.5.6 ZIP from Even's CDN](https://cdn.evenreal.co/firmware/3adb8ebbd35c2343409d6d0c9fe6cbb9.zip),
  linked by the [G1 protocol investigation](https://github.com/JohnRThomas/EvenDemoApp/wiki/Even-Realities-G1-BLE-Protocol).
- ZIP SHA-256: `40f5839def1c00da3e0ffea9274dc0e04f249596d31787bd0c497be363cf6f8f`.
- `app_update.bin` SHA-256: `1eba87bfb1df261d197ca42e0850cc4ff7e668a9e94e02a8be46369b3bfaf483`.
- Index file offset: `0x901FC`; 445 four-byte little-endian records:
  `uint16 codePoint`, `uint8 glyphWidth`, `uint8 reserved`.
- The [decompiled embedded lookup](https://github.com/JohnRThomas/even_realities_decomp/blob/f571782aedb6fdefbcbfe2a4d1e309bb47143581/src/app/FUN_00047f00.c)
  scans 445 records and doubles the raw width. Its memory addresses differ from
  this older image; the 1.5.6 index was located by its ASCII glyph sequence.
- The [decompiled resource manager](https://github.com/JohnRThomas/even_realities_decomp/blob/f571782aedb6fdefbcbfe2a4d1e309bb47143581/src/app/resource_manger_get.c)
  tries the embedded lookup and then external-flash indexes. Therefore this CSV
  is the complete embedded index in this image, **not a complete list of all
  G1-supported Unicode characters**. External-flash fonts and other firmware
  versions can add coverage. Inclusion is firmware evidence, not a new physical
  display test.
- [Even's G1 FAQ](https://support.evenrealities.com/hc/en-us/articles/13489269281167-General-FAQs)
  also lists Swedish among supported translation languages.

Download the ZIP and reproduce the CSV without installing firmware:

```sh
python3 scripts/extract-g1-font.py /path/to/g1-1.5.6.zip > /tmp/g1-glyphs.csv
diff -u notes/g1-embedded-glyphs.csv /tmp/g1-glyphs.csv
```

## Display policy

G1 preserves ASCII and the embedded index's extended Latin letters. Decomposed
Latin clusters are composed to NFC first, so both `Hallå` and `Halla\u030A`
send the same `å` glyph. Unmapped Latin clusters retain the existing base-letter
fallback (for example `Đặng` → `Dang`, `Œ` → `OE`). Other scripts, their combining
marks, punctuation, spaces, and newlines pass through unchanged. An unmapped
Latin letter is not proof the external-flash fonts cannot render it; expanding
the preservation list needs additional glyph evidence.

The host's G1 profile normalizes before measuring, wrapping, and enforcing UTF-8
payload limits. Android and Apple native paths repeat the operation before BLE
encoding; it is idempotent. NIMO retains its own accent-stripping policy and G2
continues to send Unicode unchanged.
