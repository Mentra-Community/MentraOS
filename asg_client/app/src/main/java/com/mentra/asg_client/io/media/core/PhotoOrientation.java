package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.graphics.Matrix;
import androidx.exifinterface.media.ExifInterface;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** Shared display transform for tagless preview and BLE JPEG pixels. */
final class PhotoOrientation {
  static int read(byte[] jpegBytes, String jpegPath) throws IOException {
    ExifInterface exif = jpegBytes != null
        ? new ExifInterface(new ByteArrayInputStream(jpegBytes)) : new ExifInterface(jpegPath);
    return exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
  }

  // Returns source for identity transforms. The caller owns both bitmaps and must recycle
  // the original only when a distinct bitmap is returned.
  static Bitmap apply(Bitmap source, int orientation) {
    Matrix transform = new Matrix();
    switch (orientation) {
      case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: transform.setScale(-1, 1); break;
      case ExifInterface.ORIENTATION_ROTATE_180: transform.setRotate(180); break;
      case ExifInterface.ORIENTATION_FLIP_VERTICAL: transform.setScale(1, -1); break;
      case ExifInterface.ORIENTATION_TRANSPOSE:
        transform.setRotate(90); transform.postScale(-1, 1); break;
      case ExifInterface.ORIENTATION_ROTATE_90: transform.setRotate(90); break;
      case ExifInterface.ORIENTATION_TRANSVERSE:
        transform.setRotate(90); transform.postScale(1, -1); break;
      case ExifInterface.ORIENTATION_ROTATE_270: transform.setRotate(270); break;
      default: break;
    }
    return Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), transform, true);
  }
}
