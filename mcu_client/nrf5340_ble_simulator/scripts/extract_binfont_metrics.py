#!/usr/bin/env python3
"""
Extract glyph advance widths from an LVGL v9 binfont (.bin) file.

The binary format (from mos_binfont_lvgl.c):
  [head: length(4) + "head"(4) + font_header_bin_t]
  [cmap: length(4) + "cmap"(4) + count(4) + cmap_table[]]
  [loca: length(4) + "loca"(4) + count(4) + offset[]]
  [glyf: length(4) + "glyf"(4) + glyph_records...]

Each glyph record is a packed bit stream:
  adv_w       (advance_width_bits bits, FP4 if advance_width_format==1)
  ofs_x       (xy_bits bits, signed)
  ofs_y       (xy_bits bits, signed)
  box_w       (wh_bits bits)
  box_h       (wh_bits bits)
  bitmap data (box_w * box_h * bpp bits)

Usage:
  python3 extract_binfont_metrics.py font_en_18.bin
"""

import struct
import sys
import os


def read_le16(data, offset):
    return struct.unpack_from("<H", data, offset)[0]

def read_le32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]

def read_le16s(data, offset):
    return struct.unpack_from("<h", data, offset)[0]


class BitReader:
    def __init__(self, data, byte_offset=0):
        self.data = data
        self.byte_pos = byte_offset
        self.bit_pos = -1
        self.byte_val = 0

    def read_bits(self, n):
        """Read n bits, MSB first (same as mem_read_bits in mos_binfont_lvgl.c)."""
        value = 0
        for _ in range(n):
            if self.bit_pos < 0:
                self.byte_val = self.data[self.byte_pos]
                self.byte_pos += 1
                self.bit_pos = 7
            value = (value << 1) | ((self.byte_val >> self.bit_pos) & 1)
            self.bit_pos -= 1
        return value

    def read_bits_signed(self, n):
        v = self.read_bits(n)
        if v & (1 << (n - 1)):
            v |= ~0 << n
        return v


def parse_binfont(path):
    with open(path, "rb") as f:
        data = bytearray(f.read())

    # --- head section ---
    head_len = read_le32(data, 0)
    assert data[4:8] == b"head", f"Expected 'head' tag, got {data[4:8]!r}"

    # font_header_bin_t starts at offset 8
    h_off = 8
    version          = read_le32(data, h_off);  h_off += 4
    tables_count     = read_le16(data, h_off);  h_off += 2
    font_size        = read_le16(data, h_off);  h_off += 2
    ascent           = read_le16(data, h_off);  h_off += 2
    descent          = read_le16s(data, h_off); h_off += 2
    typo_ascent      = read_le16(data, h_off);  h_off += 2
    typo_descent     = read_le16s(data, h_off); h_off += 2
    typo_line_gap    = read_le16(data, h_off);  h_off += 2
    min_y            = read_le16s(data, h_off); h_off += 2
    max_y            = read_le16s(data, h_off); h_off += 2
    default_adv_w    = read_le16(data, h_off);  h_off += 2
    kerning_scale    = read_le16(data, h_off);  h_off += 2
    index_to_loc_fmt = data[h_off];             h_off += 1
    glyph_id_fmt     = data[h_off];             h_off += 1
    adv_w_fmt        = data[h_off];             h_off += 1  # 1 = FP4
    bpp              = data[h_off];             h_off += 1
    xy_bits          = data[h_off];             h_off += 1
    wh_bits          = data[h_off];             h_off += 1
    adv_w_bits       = data[h_off];             h_off += 1
    compression_id   = data[h_off];             h_off += 1

    line_height = max_y - min_y

    print(f"Font: {os.path.basename(path)}")
    print(f"  font_size={font_size}pt  ascent={ascent}  descent={descent}")
    print(f"  line_height={line_height}px  (max_y={max_y} - min_y={min_y})")
    print(f"  adv_w_bits={adv_w_bits}  adv_w_format={'FP4' if adv_w_fmt==1 else 'integer'}")
    print(f"  xy_bits={xy_bits}  wh_bits={wh_bits}  bpp={bpp}  compression={compression_id}")
    print(f"  default_adv_w={default_adv_w}")
    print()

    # --- cmap section ---
    cmap_start = head_len
    assert data[cmap_start+4:cmap_start+8] == b"cmap", "Expected 'cmap'"
    cmap_len   = read_le32(data, cmap_start)
    cmap_count = read_le32(data, cmap_start + 8)

    # Parse cmap_table_bin_t array (16 bytes each):
    #   data_offset(4) range_start(4) range_length(2) glyph_id_start(2)
    #   data_entries_count(2) format_type(1) padding(1)
    cmap_tables = []
    t_off = cmap_start + 12
    for _ in range(cmap_count):
        data_offset        = read_le32(data, t_off); t_off += 4
        range_start        = read_le32(data, t_off); t_off += 4
        range_length       = read_le16(data, t_off); t_off += 2
        glyph_id_start     = read_le16(data, t_off); t_off += 2
        data_entries_count = read_le16(data, t_off); t_off += 2
        format_type        = data[t_off];             t_off += 1
        padding            = data[t_off];             t_off += 1
        cmap_tables.append({
            "data_offset": data_offset, "range_start": range_start,
            "range_length": range_length, "glyph_id_start": glyph_id_start,
            "data_entries_count": data_entries_count, "format_type": format_type,
        })

    # LVGL cmap format constants (from lv_font.h)
    FMT_FORMAT0_FULL = 0
    FMT_SPARSE_FULL  = 1
    FMT_FORMAT0_TINY = 2
    FMT_SPARSE_TINY  = 3

    def find_glyph_id(unicode_cp):
        for tbl in cmap_tables:
            if not (tbl["range_start"] <= unicode_cp < tbl["range_start"] + tbl["range_length"]):
                continue
            rcp = unicode_cp - tbl["range_start"]
            data_start = cmap_start + tbl["data_offset"]
            fmt = tbl["format_type"]
            if fmt == FMT_FORMAT0_TINY:
                if rcp < tbl["data_entries_count"]:
                    return tbl["glyph_id_start"] + rcp
            elif fmt == FMT_FORMAT0_FULL:
                if rcp < tbl["data_entries_count"]:
                    return tbl["glyph_id_start"] + data[data_start + rcp]
            elif fmt in (FMT_SPARSE_TINY, FMT_SPARSE_FULL):
                left, right = 0, tbl["data_entries_count"] - 1
                while left <= right:
                    mid = (left + right) // 2
                    val = read_le16(data, data_start + mid * 2)
                    if val == rcp:
                        if fmt == FMT_SPARSE_FULL:
                            ofs_start = data_start + tbl["data_entries_count"] * 2
                            ofs = read_le16(data, ofs_start + mid * 2)
                            return tbl["glyph_id_start"] + ofs
                        else:
                            return tbl["glyph_id_start"] + mid
                    elif val < rcp:
                        left = mid + 1
                    else:
                        right = mid - 1
        return None

    # --- loca section ---
    loca_start = cmap_start + cmap_len
    assert data[loca_start+4:loca_start+8] == b"loca", "Expected 'loca'"
    loca_len   = read_le32(data, loca_start)
    loca_count = read_le32(data, loca_start + 8)
    loca_offsets_start = loca_start + 12

    def read_loca(index):
        if index_to_loc_fmt == 0:
            return read_le16(data, loca_offsets_start + index * 2)
        else:
            return read_le32(data, loca_offsets_start + index * 4)

    # --- glyf section ---
    glyf_start = loca_start + loca_len
    assert data[glyf_start+4:glyf_start+8] == b"glyf", "Expected 'glyf'"
    glyf_len   = read_le32(data, glyf_start)  # includes 8-byte label

    def decode_glyph(glyph_id):
        if glyph_id >= loca_count:
            return None
        g_off  = read_loca(glyph_id)
        g_next = read_loca(glyph_id + 1) if glyph_id + 1 < loca_count else glyf_len
        if g_off >= g_next:
            return None  # empty glyph

        file_off = glyf_start + g_off
        br = BitReader(data, file_off)

        if adv_w_bits == 0:
            raw_adv = default_adv_w
        else:
            raw_adv = br.read_bits(adv_w_bits)
            if raw_adv == 0 and default_adv_w > 0:
                raw_adv = default_adv_w

        # Decode FP4 if advance_width_format == 1
        if adv_w_fmt == 1:
            adv_w = (raw_adv + 8) // 16
            if adv_w == 0 and raw_adv != 0:
                adv_w = 1
        else:
            adv_w = raw_adv

        # Clamp (same guard as firmware)
        max_adv = font_size * 6
        if adv_w > max_adv:
            adv_w = max_adv

        ofs_x = br.read_bits_signed(xy_bits)
        ofs_y = br.read_bits_signed(xy_bits)
        box_w = br.read_bits(wh_bits)
        box_h = br.read_bits(wh_bits)

        if adv_w < box_w:
            adv_w = box_w

        return {"adv_w": adv_w, "box_w": box_w, "box_h": box_h, "ofs_x": ofs_x, "ofs_y": ofs_y}

    # ASCII printable range 0x20-0x7E
    CHARS = (
        " !\"#$%&'()*+,-./"
        "0123456789"
        ":;<=>?@"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "[\\]^_`"
        "abcdefghijklmnopqrstuvwxyz"
        "{|}~"
    )

    results = {}
    for ch in CHARS:
        cp = ord(ch)
        gid = find_glyph_id(cp)
        if gid is None:
            print(f"  '{ch}' (U+{cp:04X}): NOT IN FONT")
            continue
        g = decode_glyph(gid)
        if g is None:
            g_off  = read_loca(gid)
            g_next = read_loca(gid + 1) if gid + 1 < loca_count else glyf_len
            if g_off == g_next:
                results[ch] = {"adv_w": default_adv_w or 0, "box_w": 0, "box_h": 0, "ofs_x": 0, "ofs_y": 0}
            else:
                results[ch] = {"adv_w": 0, "box_w": 0, "box_h": 0, "ofs_x": 0, "ofs_y": 0}
        else:
            results[ch] = g

    # Print table
    print(f"{'Char':<6} {'Unicode':<8} {'adv_w':>6} {'box_w':>6} {'box_h':>6} {'ofs_x':>6} {'ofs_y':>6}")
    print("-" * 50)
    for ch in CHARS:
        if ch not in results:
            continue
        g = results[ch]
        display = repr(ch) if ch in ' \\"' else f"'{ch}'"
        cp = ord(ch)
        print(f"{display:<6} U+{cp:04X}   {g['adv_w']:>6} {g['box_w']:>6} {g['box_h']:>6} {g['ofs_x']:>6} {g['ofs_y']:>6}")

    # Stats
    vals = [g["adv_w"] for g in results.values() if g["adv_w"] > 0]
    print()
    print(f"Line height (uniform): {line_height}px")
    print(f"adv_w  min={min(vals)}  max={max(vals)}  avg={sum(vals)/len(vals):.1f}")
    print()

    # TypeScript output
    print("// NEX_GLYPH_WIDTHS — actual adv_w values from binary font")
    print("// use renderFormula: (w) => w")
    print("const NEX_GLYPH_WIDTHS: Record<string, number> = {")
    categories = [
        ("Punctuation & Symbols", " !\"#$%&'()*+,-./"),
        ("Numbers",               "0123456789"),
        ("More punctuation",      ":;<=>?@"),
        ("Uppercase",             "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        ("Brackets & special",    "[\\]^_`"),
        ("Lowercase",             "abcdefghijklmnopqrstuvwxyz"),
        ("More special",          "{|}~"),
    ]
    for label, chars in categories:
        print(f"  // {label}")
        for ch in chars:
            if ch not in results:
                continue
            key = ch.replace("\\", "\\\\").replace('"', '\\"')
            print(f'  "{key}": {results[ch]["adv_w"]},')
        print()
    print("}")

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <font.bin>")
        sys.exit(1)
    parse_binfont(sys.argv[1])
