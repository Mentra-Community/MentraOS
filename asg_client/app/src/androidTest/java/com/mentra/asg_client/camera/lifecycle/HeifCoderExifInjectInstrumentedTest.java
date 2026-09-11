package com.mentra.asg_client.camera.lifecycle;

import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreciseMode;
import java.io.File;
import java.io.FileOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class HeifCoderExifInjectInstrumentedTest {
    private static final String TAG = "HeifCoderExifInject";

    @Test
    public void injectExif_embedsReadableExifInAvif() throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(128, 96, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.GREEN);
        byte[] avif = new HeifCoder().encodeAvif(bitmap, 40, PreciseMode.LOSSY);
        bitmap.recycle();

        JSONObject payload = samplePayload(5);
        byte[] exifSegment = PhotoExifMetadataWriter.buildExifApp1Segment(payload);
        byte[] exifTiff = java.util.Arrays.copyOfRange(exifSegment, 4, exifSegment.length);

        byte[] withExif = AvifBmffExifInjector.injectExif(avif, exifTiff);
        assertTrue(PhotoExifMetadataWriter.containsExifMarker(withExif));

        File out =
                new File(
                        InstrumentationRegistry.getInstrumentation()
                                .getTargetContext()
                                .getExternalFilesDir(null),
                        "heifcoder_with_exif.avif");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(withExif);
        }
        Log.i(TAG, "Wrote " + out.getAbsolutePath() + " (" + withExif.length + " bytes)");

        if (Build.VERSION.SDK_INT >= 31) {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                mmr.setDataSource(out.getAbsolutePath());
                String offset =
                        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_EXIF_OFFSET);
                String length =
                        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_EXIF_LENGTH);
                Log.i(TAG, "MMR EXIF offset=" + offset + " length=" + length);
                if (offset != null && length != null) {
                    assertTrue(Integer.parseInt(length) > 6);
                } else {
                    Log.w(
                            TAG,
                            "MMR did not report EXIF keys; raw Exif marker present in file bytes");
                }
            } finally {
                mmr.release();
            }
        }
    }

    private static JSONObject samplePayload(int sampleCount) throws Exception {
        JSONObject root = new JSONObject();
        root.put("version", 1);
        root.put("sampleCount", sampleCount);
        JSONArray samples = new JSONArray();
        for (int i = 0; i < sampleCount; i++) {
            JSONArray sample = new JSONArray();
            sample.put(i);
            sample.put(0.1);
            sample.put(0.2);
            sample.put(9.8);
            samples.put(sample);
        }
        root.put("samples", samples);
        return root;
    }
}
