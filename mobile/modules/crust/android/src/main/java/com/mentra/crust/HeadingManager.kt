package com.mentra.crust

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log

/**
 * HeadingManager
 *
 * Reads the OS's fused rotation vector (magnetometer + accelerometer +
 * gyro) and converts it to a compass heading in degrees (0 = north,
 * clockwise). This is the same fusion Google Maps uses.
 *
 * Independent of nav — works whenever an Android Activity is around.
 */
object HeadingManager {
  private const val TAG = "HeadingManager"

  /** Minimum delta (degrees) before re-emitting. Avoids flooding JS. */
  private const val MIN_DEGREE_DELTA = 1.0f

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

    val rotationMatrix = FloatArray(9)
    val orientation = FloatArray(3)

    val sl = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        SensorManager.getOrientation(rotationMatrix, orientation)
        // orientation[0] = azimuth, in radians, [-π, π], 0 = north,
        // clockwise positive (per the Android docs).
        val azimuthRad = orientation[0]
        var degrees = Math.toDegrees(azimuthRad.toDouble()).toFloat()
        // Normalize to [0, 360)
        degrees = ((degrees % 360f) + 360f) % 360f

        if (lastEmitted < -360f || kotlin.math.abs(angleDiff(degrees, lastEmitted)) >= MIN_DEGREE_DELTA) {
          lastEmitted = degrees
          cb.onHeading(degrees)
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
