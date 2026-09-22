package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import com.mentra.asg_client.AsgConstants;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PhotoThumbnailTest {
  @Test
  public void previewPreservesAspectRatioAndNeverUpscales() throws Exception {
    checkSize(1600, 1200, 500, 375);
    checkSize(1200, 1600, 375, 500);
    checkSize(500, 500, 500, 500);
    checkSize(200, 100, 200, 100);
    assertEquals(50, AsgConstants.PHOTO_THUMBNAIL_JPEG_QUALITY);
  }

  @Test
  public void previewPixelsMatchEveryExifDisplayOrientation() throws Exception {
    // Independent corner ordering: TL/TR/BL/BR after each EXIF transform.
    int[][] expected = {{0, 1, 2, 3}, {1, 0, 3, 2}, {3, 2, 1, 0}, {2, 3, 0, 1},
        {0, 2, 1, 3}, {2, 0, 3, 1}, {3, 1, 2, 0}, {1, 3, 0, 2}};
    int[] colors = {android.graphics.Color.RED, android.graphics.Color.GREEN,
        android.graphics.Color.BLUE, android.graphics.Color.YELLOW};
    Bitmap source = Bitmap.createBitmap(160, 80, Bitmap.Config.ARGB_8888);
    for (int y = 0; y < 80; y++) {
      for (int x = 0; x < 160; x++) source.setPixel(x, y, colors[(y / 40) * 2 + x / 80]);
    }
    for (int orientation = 1; orientation <= 8; orientation++) {
      byte[] jpeg = PhotoThumbnail.encode(source, orientation);
      Bitmap preview = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
      assertEquals(orientation < 5 ? 160 : 80, preview.getWidth());
      assertEquals(orientation < 5 ? 80 : 160, preview.getHeight());
      for (int corner = 0; corner < 4; corner++) {
        int pixel = preview.getPixel(preview.getWidth() * (corner % 2 == 0 ? 1 : 3) / 4,
            preview.getHeight() * (corner < 2 ? 1 : 3) / 4);
        int target = colors[expected[orientation - 1][corner]];
        assertTrue(Math.abs(android.graphics.Color.red(pixel) - android.graphics.Color.red(target)) < 12);
        assertTrue(Math.abs(android.graphics.Color.green(pixel) - android.graphics.Color.green(target)) < 12);
        assertTrue(Math.abs(android.graphics.Color.blue(pixel) - android.graphics.Color.blue(target)) < 12);
      }
      // Pixels are already oriented; no client-side EXIF rotation is needed.
      androidx.exifinterface.media.ExifInterface exif = new androidx.exifinterface.media.ExifInterface(
          new java.io.ByteArrayInputStream(jpeg));
      assertTrue(exif.getAttributeInt(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION, 0) <= 1);
      preview.recycle();
    }
    // Identity transforms preserve the existing untagged preview path.
    assertArrayEquals(PhotoThumbnail.encode(source, 1), PhotoThumbnail.encode(source));
    assertFalse(source.isRecycled());
    source.recycle();
  }

  private void checkSize(int width, int height, int expectedWidth, int expectedHeight)
      throws Exception {
    Bitmap source = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    byte[] bytes = PhotoThumbnail.encode(source);
    assertFalse(source.isRecycled());
    assertEquals(width, source.getWidth());
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
    assertEquals(expectedWidth, bounds.outWidth);
    assertEquals(expectedHeight, bounds.outHeight);
    assertEquals("image/jpeg", bounds.outMimeType);
    source.recycle();
  }
}
