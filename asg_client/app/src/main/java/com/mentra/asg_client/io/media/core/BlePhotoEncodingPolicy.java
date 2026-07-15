package com.mentra.asg_client.io.media.core;

/**
 * Chooses the payload codec for a prepared BLE image. JPEG is used for every BLE photo because it
 * is dramatically faster to encode on Mentra Live while remaining sufficiently compact for OCR
 * transfers.
 */
final class BlePhotoEncodingPolicy {
    private BlePhotoEncodingPolicy() {}

    static BleCodec selectCodec() {
        return BleCodec.JPEG_FAST;
    }
}
