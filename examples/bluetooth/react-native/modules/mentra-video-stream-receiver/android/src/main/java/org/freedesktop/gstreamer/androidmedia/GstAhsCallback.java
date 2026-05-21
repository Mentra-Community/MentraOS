package org.freedesktop.gstreamer.androidmedia;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;

public class GstAhsCallback implements SensorEventListener {
    public long mUserData;
    public long mSensorCallback;
    public long mAccuracyCallback;

    public static native void gst_ah_sensor_on_sensor_changed(SensorEvent event,
                                                              long callback,
                                                              long user_data);
    public static native void gst_ah_sensor_on_accuracy_changed(Sensor sensor,
                                                                int accuracy,
                                                                long callback,
                                                                long user_data);

    public GstAhsCallback(long sensor_callback, long accuracy_callback, long user_data) {
        mSensorCallback = sensor_callback;
        mAccuracyCallback = accuracy_callback;
        mUserData = user_data;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        gst_ah_sensor_on_sensor_changed(event, mSensorCallback, mUserData);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        gst_ah_sensor_on_accuracy_changed(sensor, accuracy, mAccuracyCallback, mUserData);
    }
}
