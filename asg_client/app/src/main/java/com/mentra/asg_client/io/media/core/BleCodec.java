package com.mentra.asg_client.io.media.core;

/** Codec used for the compressed BLE photo payload. */
public enum BleCodec {
    /**
     * Baseline JPEG via {@link android.graphics.Bitmap#compress} (Skia's bundled libjpeg-turbo,
     * NEON-accelerated). Encodes a 1920px-class bitmap in tens of milliseconds on the MT8766
     * versus multiple seconds for the software AV1 encoder, at the cost of a somewhat larger
     * payload. Non-progressive, default Huffman tables - the fastest JPEG path available to
     * this app without a new native dependency.
     */
    JPEG_FAST,

    /**
     * AV1 still image via HeifCoder (software libaom) or AvifWriter (MediaCodec, unavailable on
     * the MT8766). Smallest payloads, but a ~4-5s software encode per photo on Mentra Live.
     */
    AVIF
}
