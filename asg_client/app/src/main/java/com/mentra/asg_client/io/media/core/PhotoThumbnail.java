package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import androidx.exifinterface.media.ExifInterface;
import com.mentra.asg_client.AsgConstants;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Encodes a bounded preview in the full image's display orientation. */
final class PhotoThumbnail {
  static byte[] encode(Bitmap source) throws IOException {
    return encode(source, ExifInterface.ORIENTATION_NORMAL);
  }

  static byte[] encode(Bitmap source, int orientation) throws IOException {
    float scale = Math.min(1f, (float) AsgConstants.PHOTO_THUMBNAIL_LONG_EDGE
        / Math.max(source.getWidth(), source.getHeight()));
    Bitmap scaled = Bitmap.createScaledBitmap(source, Math.max(1, Math.round(source.getWidth() * scale)),
        Math.max(1, Math.round(source.getHeight() * scale)), true);
    Bitmap thumbnail = scaled;
    try {
      // BitmapFactory ignores EXIF. Normalize pixels, including mirrored orientations, so the
      // JPEG preview renders correctly even in clients that ignore orientation metadata.
      thumbnail = PhotoOrientation.apply(scaled, orientation);
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      if (!thumbnail.compress(Bitmap.CompressFormat.JPEG, AsgConstants.PHOTO_THUMBNAIL_JPEG_QUALITY, output)) {
        throw new IOException("Thumbnail JPEG compression failed");
      }
      return output.toByteArray();
    } finally {
      if (thumbnail != scaled) thumbnail.recycle();
      if (scaled != source) scaled.recycle();
    }
  }
}
