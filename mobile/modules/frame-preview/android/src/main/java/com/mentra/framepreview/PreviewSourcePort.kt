package com.mentra.framepreview

import com.mentra.glassesmedia.source.DecodedFrameTap
import com.mentra.glassesmedia.source.I420Planes
import com.mentra.glassesmedia.source.VideoFrameListener

/**
 * Where preview frames come from. `attach` returns the generation that owns the sink; `detach`
 * with a stale generation is a no-op, so a late teardown cannot remove a newer subscription.
 *
 * [onSinkError] runs on the source's thread after a `Throwable` from the sink has been caught and
 * counted; it must only schedule work elsewhere.
 */
interface PreviewSourcePort {
  fun attach(sink: (I420Planes) -> Unit, onSinkError: (Throwable) -> Unit): Long

  fun detach(generation: Long): Boolean

  fun isCurrent(generation: Long): Boolean
}

/** The live call's decoded video, offered by acs-meeting just before each ACS send. */
object CallSource : PreviewSourcePort {
  override fun attach(sink: (I420Planes) -> Unit, onSinkError: (Throwable) -> Unit): Long =
    DecodedFrameTap.attach(VideoFrameListener { planes -> sink(planes) }, onSinkError)

  override fun detach(generation: Long): Boolean = DecodedFrameTap.detach(generation)

  override fun isCurrent(generation: Long): Boolean = DecodedFrameTap.isCurrent(generation)
}
