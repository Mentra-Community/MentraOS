package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import androidx.exifinterface.media.ExifInterface;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.lifecycle.PhotoExifMetadataWriter;
import java.io.FileOutputStream;
import java.io.IOException;

/** Transport-independent JPEG quality. Pixel limits are owned by size/crop policy. */
public enum PhotoCompression {
  NONE(AsgConstants.PHOTO_JPEG_QUALITY_NONE),
  LOW(AsgConstants.PHOTO_JPEG_QUALITY_LOW),
  MEDIUM(AsgConstants.PHOTO_JPEG_QUALITY_MEDIUM),
  HIGH(AsgConstants.PHOTO_JPEG_QUALITY_HIGH);

  final int jpegQuality;

  PhotoCompression(int jpegQuality) {
    this.jpegQuality = jpegQuality;
  }

  /** Parse the exact wire value; only omission defaults to none. */
  public static PhotoCompression fromValue(Object value) {
    if (value == null || "none".equals(value)) return NONE;
    if ("low".equals(value)) return LOW;
    if ("medium".equals(value)) return MEDIUM;
    if ("high".equals(value)) return HIGH;
    throw new IllegalArgumentException("Invalid photo compression: " + value);
  }

  /**
   * Re-encodes every level at {@link #jpegQuality}, including NONE at Q95: source captures use
   * size-dependent quality and cannot substitute for the delivery policy. Pixel geometry stays
   * unchanged, so copy orientation and IMU metadata rather than rotating pixels. BLE fallback
   * must reuse the original capture, never the upload copy.
   */
  String prepareUpload(String originalPath, String uploadPath) throws IOException {
    Bitmap source = BitmapFactory.decodeFile(originalPath);
    if (source == null) throw new IOException("Could not decode photo for upload");
    try (FileOutputStream output = new FileOutputStream(uploadPath)) {
      if (!source.compress(Bitmap.CompressFormat.JPEG, jpegQuality, output)) {
        throw new IOException("Photo JPEG encoding failed");
      }
    } finally {
      source.recycle();
    }
    copyOrientation(originalPath, uploadPath);
    PhotoExifMetadataWriter.copyImuMetadata(originalPath, uploadPath);
    return uploadPath;
  }

  private static void copyOrientation(String sourcePath, String destPath) throws IOException {
    String orientation = new ExifInterface(sourcePath).getAttribute(ExifInterface.TAG_ORIENTATION);
    if (orientation == null) return;
    ExifInterface dest = new ExifInterface(destPath);
    dest.setAttribute(ExifInterface.TAG_ORIENTATION, orientation);
    dest.saveAttributes();
  }
}
