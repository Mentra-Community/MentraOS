package com.mentra.crust.heading

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import kotlin.math.abs
import kotlin.math.atan2

/**
 * HeadingManager
 *
 * Reads the OS's fused rotation vector (magnetometer + accelerometer +
 * gyro) and produces a tilt-robust compass heading in degrees (0 = north,
 * clockwise). Behaves like Google Maps' compass: stable across the full
 * range of phone hold angles, including when the user raises the phone
 * toward their face.
 *
 * Independent of nav — works whenever an Android Activity is around.
 *
 * --- Why projection instead of getOrientation + remapCoordinateSystem ---
 * The previous implementation called `remapCoordinateSystem(AXIS_X, AXIS_Z)`
 * and read azimuth via `getOrientation`. That assumes the phone is held
 * near-vertical. As the phone tilts toward horizontal — or up toward the
 * user — the assumed device→world axis mapping breaks down and azimuth
 * drifts or jumps.
 *
 * Instead we directly project the device's "top edge" (+Y in device
 * coords) into the world horizontal plane and read the bearing of that
 * projection. The full 3D rotation matrix R from
 * `getRotationMatrixFromVector` carries the device→world transform with
 * world axes (X = east, Y = north, Z = up). The image of device +Y
 * under R is the second column of R; its (east, north) components are
 * R[0][1] and R[1][1] (row-major indices 1 and 4). We discard the up
 * component — that's exactly the tilt we want to ignore — and take
 * `atan2(east, north)` for the heading.
 *
 * --- Smoothing ---
 * Low-pass on the rotation MATRIX (not the angle) so we never average
 * across the 0°↔360° wrap. Alpha 0.88 ≈ 0.4 s tau at SENSOR_DELAY_UI,
 * matching the perceived smoothness of Google Maps' compass without
 * adding noticeable lag.
 */
object HeadingManager {
  private const val TAG = "HeadingManager"

  /** Minimum delta (degrees) before re-emitting. Avoids flooding JS. */
  private const val MIN_DEGREE_DELTA = 1.0f

  /**
   * Low-pass coefficient applied per-sample to each entry of the 3×3
   * rotation matrix. Higher = smoother but laggier. 0.88 at
   * SENSOR_DELAY_UI (~16 Hz) gives ~0.4 s tau.
   */
  private const val ALPHA = 0.88f

  private var sensorManager: SensorManager? = null
  private var rotationVectorSensor: Sensor? = null
  private var listener: SensorEventListener? = null
  private var lastEmitted: Float = -1000f

  interface Callback {
    fun onHeading(degrees: Float)
  }

  fun start(context: Context, cb: Callback) {
    if (listener != null) {
      Log.d(TAG, "already started")
      return
    }
    val sm = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (sm == null) {
      Log.w(TAG, "SensorManager unavailable")
      return
    }
    val sensor = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    if (sensor == null) {
      Log.w(TAG, "TYPE_ROTATION_VECTOR sensor unavailable")
      return
    }

    val raw = FloatArray(9)
    val filtered = FloatArray(9)
    var seeded = false

    val sl = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        SensorManager.getRotationMatrixFromVector(raw, event.values)

        if (!seeded) {
          // Seed the filter from the first sample so we don't slow-pan
          // from the identity matrix toward the real orientation over
          // the first ~30 samples after start().
          System.arraycopy(raw, 0, filtered, 0, 9)
          seeded = true
        } else {
          for (i in 0 until 9) {
            filtered[i] = ALPHA * filtered[i] + (1f - ALPHA) * raw[i]
          }
        }

        // R is row-major device→world. The image of device +Y
        // (the top edge of the phone in portrait) under R is the
        // second column, whose east / north components live at
        // indices 1 and 4. The up component (index 7) is exactly
        // the tilt we want to ignore — discard it.
        val east = filtered[1]
        val north = filtered[4]
        val deg = ((Math.toDegrees(atan2(east, north).toDouble()).toFloat()) + 360f) % 360f
        if (!deg.isFinite()) return

        if (lastEmitted < -360f || abs(angleDiff(deg, lastEmitted)) >= MIN_DEGREE_DELTA) {
          lastEmitted = deg
          cb.onHeading(deg)
        }
      }

      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }

    sm.registerListener(sl, sensor, SensorManager.SENSOR_DELAY_UI)
    sensorManager = sm
    rotationVectorSensor = sensor
    listener = sl
    Log.d(TAG, "started")
  }

  fun stop() {
    val sm = sensorManager
    val sl = listener
    if (sm != null && sl != null) {
      sm.unregisterListener(sl)
      Log.d(TAG, "stopped")
    }
    sensorManager = null
    rotationVectorSensor = null
    listener = null
    lastEmitted = -1000f
  }

  /** Smallest signed difference between two compass headings. */
  private fun angleDiff(a: Float, b: Float): Float {
    var d = (a - b) % 360f
    if (d > 180f) d -= 360f
    if (d < -180f) d += 360f
    return d
  }
}
