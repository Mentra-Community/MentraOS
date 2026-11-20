package com.mentra.glassesmedia.source

/**
 * The managed relay's per-frame fan-out: the publisher first, the phone's own preview second.
 *
 * [publisher] has returned before the preview is consulted, so nothing a preview does can delay,
 * reorder or drop a frame on its way to Cloudflare. The preview's share is [DecodedFrameTap.offer],
 * which contains anything its sink throws and returns without doing real work: the sink decides,
 * retains the planes if it wants them past this callback, and packs on its own thread.
 *
 * Encoded passthrough frames never arrive here. They carry no pixels, so a passthrough stream has
 * no local preview.
 */
fun relayFrameFanOut(publisher: VideoFrameListener): VideoFrameListener = VideoFrameListener { planes ->
  publisher.onVideoFrame(planes)
  DecodedFrameTap.offer(planes, DecodedFrameProducer.RELAY)
}
