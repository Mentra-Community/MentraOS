# JPEG quality sweep

These outputs were generated on-device with the BLE encoder benchmark. Each
image directory contains the AVIF q55 output plus JPEG q75, q80, q85, q90,
q95, and q100 outputs. The encoded image files themselves are gitignored —
regenerate them locally with the benchmark harness if you need to inspect
them; only this summary is committed.

Times are encoder time in milliseconds. Sizes are encoded payload bytes.

| Image | AVIF q55 | JPEG q80 | JPEG q85 | JPEG q90 | JPEG q95 | JPEG q100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| clear_doorjam | 18,941 / 298 ms | 65,082 / 8 ms | 79,889 / 7 ms | 90,094 / 8 ms | 109,560 / 8 ms | 183,549 / 10 ms |
| semiclear_covered | 18,030 / 537 ms | 57,358 / 9 ms | 70,803 / 10 ms | 81,211 / 10 ms | 100,155 / 12 ms | 174,095 / 13 ms |
| clear_photo1 | 35,435 / 506 ms | 84,392 / 8 ms | 102,897 / 8 ms | 117,639 / 8 ms | 142,465 / 8 ms | 226,016 / 10 ms |
| zoomtest_photo1 | 9,689 / 436 ms | 35,038 / 7 ms | 38,183 / 8 ms | 40,415 / 8 ms | 49,589 / 9 ms | 100,409 / 10 ms |
| test_photo1 | 42,926 / 706 ms | 107,037 / 10 ms | 131,053 / 9 ms | 149,086 / 10 ms | 180,183 / 25 ms | 302,052 / 20 ms |
| clear_photo1_rotated | 35,267 / 491 ms | 84,004 / 8 ms | 102,843 / 8 ms | 117,455 / 9 ms | 142,354 / 9 ms | 225,742 / 19 ms |

Format in each cell is `bytes / encode time`.

The q100 outputs are still JPEG-compressed, but their size is roughly 2x q95
and 2.5–3x q85 on these images. The q85–q90 range is the practical quality
ceiling for BLE OCR photos.
