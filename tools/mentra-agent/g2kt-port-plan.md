# G2.kt displayBitmap port plan (from harness findings, fw 2.2.4.34)

Source of truth: tools/mentra-agent/CONFORMANCE.md ("G2 bitmap display:
protocol cracked" + "follow-ups" sections); working reference
tools/mentra-agent/ble/manager.mjs (displayImageTiled/_rebuildOwned/updateImage).

File: mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/G2.kt
(mirror later: ios/Source/sgcs/G2.swift)

## Required changes

1. displayBitmap(): replace single-container path with strip tiling:
   - target rect (default 188,44 200x100; clamp w 20-288, h 20-144)
   - rowBytes = ((w+1)/2 + 3) & ~3 ; maxRows = (4096-118)/rowBytes
   - split into <= 4 horizontal strips (ids from imageContainerIDPool, but
     NEVER id 1 if a text container with id 1 is on the page — ids 2..5 safe;
     current pool 10-13 NEVER REGISTERS on this fw: change pool to [2,3,4,5])
2. rebuildState()/createPageWithContainers(): image containers must be
   declared via REBUILD_PAGE on an owned page:
   - if !pageCreated: shutdown -> delay 300 -> createPageMessage(TEXT only)
     -> pageCreated = true -> delay 300
   - then rebuildPageMessage(text + image strip containers) — NOT create.
3. sendImageData(): one updateImageRawDataMessage per strip (whole strip BMP
   <= 4096B, mapFragmentIndex=0, omit compressMode f5); 300ms between strips
   blind, or parse ImgRes ack (reply f6 sub-f8: 4 ok / 5 fail, magic echoed
   in f2) and gate. Multi-fragment NEVER works — remove the >4096 loop or
   guard it with an error log.
4. convertToG2Bmp(): unchanged (format verified correct); optionally add
   Floyd-Steinberg dither to 16 levels (big legibility win, see bmp.mjs
   ditherTo16).
5. Text after image-only pages: UPDATE_TEXT_DATA to a page without a text
   container CRASHES the BLE link — ensure every page keeps the default
   event-capture text container id 1 (G2.kt already does this in
   createPageWithContainers; keep it in the rebuild too).
6. Concurrent image streams corrupt each other — keep all image sends under
   displayMutex (already the case).

## Verify

- gradle :bluetooth-sdk compile; then on-hardware via the harness daemon is
  NOT possible for this path (app must own the BLE link) — needs a phone test
  or the user's G2 freed from the daemon.

Status (2026-06-11 ~13:30): G2.kt items DONE in commit 7824a34b9 — ID pool
2-5, sendImageData single-fragment guard + session+=2, createPageWithContainers
owns page via text-only CREATE then declares containers via REBUILD.
DONE also: (a) displayBitmap strip tiling (commit on agent-harness).
REMAINING: (b) optional Floyd-Steinberg dither in
convertToG2Bmp; (c) mirror all changes into ios/Source/sgcs/G2.swift;
(d) compile check (cd mobile && bun expo prebuild already done previously;
gradle compile via android studio/CI — at minimum kotlin syntax review);
(e) hardware verify needs the app owning the G2 (free it from the daemon).
Chip task_e6e5cbb9 covers the same ground — dismiss or point it at this plan.
