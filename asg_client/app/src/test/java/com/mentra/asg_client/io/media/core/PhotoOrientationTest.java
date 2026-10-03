package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import androidx.exifinterface.media.ExifInterface;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PhotoOrientationTest {
  @Rule public TemporaryFolder mFiles = new TemporaryFolder();

  @Test
  public void directPreviewMatchesRamBleAndFallbackForEveryOrientation() throws Exception {
    JSONObject imu = new JSONObject("{\"samples\":[{\"t\":1,\"x\":0.5}]}");
    for (int orientation = 1; orientation <= 8; orientation++) {
      File source = mFiles.newFile("source-" + orientation + ".jpg");
      Bitmap sensor = Bitmap.createBitmap(160, 80, Bitmap.Config.ARGB_8888);
      for (int y = 0; y < 80; y++) {
        for (int x = 0; x < 160; x++) sensor.setPixel(x, y,
            android.graphics.Color.rgb(x < 80 ? 240 : 10, y < 40 ? 240 : 10, 10));
      }
      try (FileOutputStream out = new FileOutputStream(source)) {
        assertTrue(sensor.compress(Bitmap.CompressFormat.JPEG, 95, out));
      }
      sensor.recycle();
      ExifInterface exif = new ExifInterface(source.getPath());
      exif.setAttribute(ExifInterface.TAG_ORIENTATION, Integer.toString(orientation));
      exif.setAttribute(ExifInterface.TAG_USER_COMMENT, imu.toString());
      exif.saveAttributes();
      byte[] capture = Files.readAllBytes(source.toPath());
      Bitmap decoded = BitmapFactory.decodeByteArray(capture, 0, capture.length);
      assertEquals(orientation, PhotoOrientation.read(capture, "not-persisted.jpg"));
      assertEquals(orientation, PhotoOrientation.read(null, source.getPath()));
      byte[] previewBytes = PhotoThumbnail.encode(decoded, PhotoOrientation.read(null, source.getPath()));
      Bitmap preview = BitmapFactory.decodeByteArray(previewBytes, 0, previewBytes.length);
      // Direct delivery retains its EXIF; fallback and RAM-first delivery normalize pixels
      // before the existing BLE encoder. This also covers fallback after the preview was sent.
      String upload = PhotoCompression.NONE.prepareUpload(source.getPath(),
          mFiles.newFile("upload-" + orientation + ".jpg").getPath());
      assertEquals(orientation, PhotoOrientation.read(null, upload));
      for (boolean ramFirst : new boolean[] {true, false}) {
        Bitmap oriented = PhotoOrientation.apply(decoded, ramFirst
            ? PhotoOrientation.read(capture, null) : PhotoOrientation.read(null, source.getPath()));
        byte[] fullBytes = BlePhotoEncoders.encode(oriented, BleCodec.JPEG_FAST, 95,
            ramFirst ? null : source.getPath(), ramFirst ? imu : null, source.getPath()).data;
        Bitmap full = BitmapFactory.decodeByteArray(fullBytes, 0, fullBytes.length);
        assertEquals(preview.getWidth(), full.getWidth());
        assertEquals(preview.getHeight(), full.getHeight());
        for (int y : new int[] {full.getHeight() / 4, full.getHeight() * 3 / 4}) {
          for (int x : new int[] {full.getWidth() / 4, full.getWidth() * 3 / 4}) {
            int expected = preview.getPixel(x, y), actual = full.getPixel(x, y);
            assertTrue(Math.abs(android.graphics.Color.red(expected) - android.graphics.Color.red(actual)) < 12);
            assertTrue(Math.abs(android.graphics.Color.green(expected) - android.graphics.Color.green(actual)) < 12);
          }
        }
        ExifInterface fullExif = new ExifInterface(new ByteArrayInputStream(fullBytes));
        assertTrue(fullExif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 0) <= 1);
        assertEquals(imu.toString(), fullExif.getAttribute(ExifInterface.TAG_USER_COMMENT));
        full.recycle();
        if (oriented != decoded) oriented.recycle();
      }
      assertArrayEquals(capture, Files.readAllBytes(source.toPath()));
      decoded.recycle();
      preview.recycle();
    }
  }
}
