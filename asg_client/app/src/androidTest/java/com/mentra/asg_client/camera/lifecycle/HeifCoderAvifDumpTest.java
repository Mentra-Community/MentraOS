package com.mentra.asg_client.camera.lifecycle;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreciseMode;
import java.io.File;
import java.io.FileOutputStream;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class HeifCoderAvifDumpTest {
    private static final String TAG = "HeifCoderAvifDump";

    @Test
    public void dumpHeifCoderAvifBoxTree() throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(128, 96, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.BLUE);
        byte[] avif = new HeifCoder().encodeAvif(bitmap, 40, PreciseMode.LOSSY);
        bitmap.recycle();

        Log.i(TAG, "AVIF size=" + avif.length);
        AvifBmffExifInjector.logBoxTree(avif, TAG);

        File out =
                new File(
                        InstrumentationRegistry.getInstrumentation()
                                .getTargetContext()
                                .getExternalFilesDir(null),
                        "heifcoder_sample.avif");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(avif);
        }
        Log.i(TAG, "Wrote " + out.getAbsolutePath());
    }
}
