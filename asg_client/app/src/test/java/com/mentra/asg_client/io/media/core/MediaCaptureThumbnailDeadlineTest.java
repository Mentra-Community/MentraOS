package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.feedback.PhotoFeedbackController;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
@LooperMode(LooperMode.Mode.PAUSED)
public class MediaCaptureThumbnailDeadlineTest {
  private MediaCaptureService mService;
  private AtomicReference<String> mActive;

  @Before
  public void setup() throws Exception {
    mService = mock(MediaCaptureService.class, CALLS_REAL_METHODS);
    for (Field field : MediaCaptureService.class.getDeclaredFields()) {
      if (Map.class.isAssignableFrom(field.getType())) set(field.getName(), new ConcurrentHashMap<>());
    }
    mActive = new AtomicReference<>("request");
    set("activePhotoJobRequestId", mActive);
    set("captureSafetyTimeoutLock", new Object());
    set("mainHandler", new Handler(Looper.getMainLooper()));
    set("photoFeedbackController", mock(PhotoFeedbackController.class));
    doNothing().when(mService).sendPhotoErrorResponse(anyString(), anyString(), anyString());
  }

  @Test
  public void slowSuccessfulPreviewLeavesTimeForFullDelivery() throws Exception {
    mService.requestThumbnail("request", "I1234567");
    invoke("startCaptureSafetyTimeout");
    advance(5); // Capture.
    PhotoTransferAck ack = new PhotoTransferAck(AsgConstants.PHOTO_THUMBNAIL_TIMEOUT_SECONDS * 1000L);
    advance(26); // Still inside preview allowance, but beyond the old SDK deadline.
    ack.result.complete(true);
    ack.await();
    advance(30); // Full delivery retains its own allowance.
    assertEquals("request", mActive.get());
    invoke("releasePhotoJob");
    advance(60);
    verify(mService, never()).sendPhotoErrorResponse(anyString(), anyString(), anyString());
  }

  @Test
  public void previewJobHasOneBoundedDeadlineEvenAfterPreviewIsConsumed() throws Exception {
    mService.requestThumbnail("request", "I1234567");
    invoke("startCaptureSafetyTimeout");
    Field ids = MediaCaptureService.class.getDeclaredField("photoThumbnailIds");
    ids.setAccessible(true);
    ((Map<?, ?>) ids.get(mService)).clear(); // startThumbnail consumes the opt-in once.
    advance(104);
    assertEquals("request", mActive.get());
    advance(1);
    assertNull(mActive.get());
    verify(mService).sendPhotoErrorResponse(eq("request"), eq("CAPTURE_TIMEOUT"), anyString());
    assertEquals(110_000, AsgConstants.PHOTO_THUMBNAIL_REQUEST_TIMEOUT_MS);
  }

  @Test
  public void ordinaryJobKeepsItsExistingWatchdog() throws Exception {
    invoke("startCaptureSafetyTimeout");
    advance(44);
    assertEquals("request", mActive.get());
    advance(1);
    assertNull(mActive.get());
  }

  private void advance(long seconds) {
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds));
  }

  private void invoke(String name) throws Exception {
    Method method = MediaCaptureService.class.getDeclaredMethod(name, String.class);
    method.setAccessible(true);
    method.invoke(mService, "request");
  }

  private void set(String name, Object value) throws Exception {
    Field field = MediaCaptureService.class.getDeclaredField(name);
    field.setAccessible(true);
    field.set(mService, value);
  }
}
