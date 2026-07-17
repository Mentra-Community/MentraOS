package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CaptureRequest;
import android.os.Handler;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.model.CameraOperationError;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoSessionTest {

    @Before
    @After
    public void drainQueue() {
        QueuedPhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @Test
    public void dispatchNextPhotoRequest_idleWithConfiguredCamera_loadsRequestAndPosts()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest same =
                new QueuedPhotoRequest("/tmp/p.jpg", "medium", false, true, null, null);
        QueuedPhotoRequestQueue.getInstance().offer(same);

        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, same);

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks, never()).closeCamera();
        verify(hooks.backgroundHandler()).postAtFrontOfQueue(any(Runnable.class));
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.WAITING_AE);
    }

    @Test
    public void dispatchNextPhotoRequest_configuredCamera_sizeChange_routesThroughSetup()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest("/tmp/old.jpg", "small", false, true, null, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);

        QueuedPhotoRequestQueue.getInstance()
                .offer(new QueuedPhotoRequest("/tmp/new.jpg", "large", false, true, null, null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks).closeCamera();
        verify(hooks).openCameraInternal("/tmp/new.jpg", false);
    }

    @Test
    public void dispatchNextPhotoRequest_afterShotClearsCurrent_sameConfig_reusesSession()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest("/tmp/old.jpg", "large", false, false, null, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        QueuedPhotoRequestQueue.getInstance()
                .offer(new QueuedPhotoRequest("/tmp/new.jpg", "large", false, false, null, null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks, never()).closeCamera();
        verify(hooks, never()).openCameraInternal(anyString(), eq(false));
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.WAITING_AE);
    }

    @Test
    public void dispatchNextPhotoRequest_afterShotClearsCurrent_sdkFlagChange_reopens()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest("/tmp/old.jpg", "large", false, false, null, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        QueuedPhotoRequestQueue.getInstance()
                .offer(new QueuedPhotoRequest("/tmp/sdk.jpg", "large", false, true, null, null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks).closeCamera();
        verify(hooks).openCameraInternal("/tmp/sdk.jpg", false);
    }

    @Test
    public void dispatchNextPhotoRequest_configuredCamera_zslMfnrChange_reopens() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings zslOn = new PhotoCaptureSettings.Builder().zslMfnr(true).build();
        PhotoCaptureSettings zslOff = new PhotoCaptureSettings.Builder().zslMfnr(false).build();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest(
                        "/tmp/zsl-on.jpg", "large", false, true, null, null, zslOn, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        QueuedPhotoRequestQueue.getInstance()
                .offer(
                        new QueuedPhotoRequest(
                                "/tmp/zsl-off.jpg",
                                "large",
                                false,
                                true,
                                null,
                                null,
                                zslOff,
                                null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks).closeCamera();
        verify(hooks).openCameraInternal("/tmp/zsl-off.jpg", false);
    }

    @Test
    public void onCameraClosed_clearsConfiguredSnapshot() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest("/tmp/old.jpg", "large", false, false, null, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        session.onCameraClosed();

        QueuedPhotoRequestQueue.getInstance()
                .offer(new QueuedPhotoRequest("/tmp/new.jpg", "large", false, false, null, null));

        session.dispatchNextPhotoRequest();

        verify(hooks, never()).closeCamera();
        verify(hooks, never()).openCameraInternal(anyString(), eq(false));
    }

    @Test
    public void dispatchNextPhotoRequest_emptyQueue_startsPostCaptureKeepAlive() {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();

        PhotoSession session = new PhotoSession(hooks);
        session.dispatchNextPhotoRequest();

        verify(hooks).startPostCaptureKeepAlive();
        verify(hooks, never()).cancelKeepAliveTimer();
    }

    @Test
    public void finishFailedPhotoCapture_clearsActiveCaptureBeforeDispatch() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        QueuedPhotoRequest request =
                new QueuedPhotoRequest("/tmp/failed.jpg", "large", false, true, null, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, request);

        Method finishFailed =
                PhotoSession.class.getDeclaredMethod("finishFailedPhotoCapture", String.class);
        finishFailed.setAccessible(true);
        finishFailed.invoke(session, "Failed to save image");

        assertThat(activeCapture(session)).isNull();
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.IDLE);
        verify(hooks).startPostCaptureKeepAlive();
    }

    @Test
    public void notifyHostPhotoError_preservesStructuredPhotoError() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest request =
                new QueuedPhotoRequest("/tmp/failed.jpg", "large", false, true, null, callback);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, request);
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_DEVICE);

        session.notifyHostPhotoError(error);

        verify(callback).onPhotoError(error);
    }

    @Test
    public void notifyHostPhotoError_stringDuringWarmUp_usesWarmUpFailureCode() {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        when(hooks.coordinator().isCameraKeptAlive()).thenReturn(false);
        PhotoSession session = new PhotoSession(hooks);
        AtomicReference<CameraOperationError> receivedError = new AtomicReference<>();
        session.setupWarmUp(
                "large", null, PhotoCaptureSettings.EMPTY, 30_000, () -> {}, receivedError::set);

        session.notifyHostPhotoError("Camera disconnected");

        assertThat(receivedError.get().code())
                .isEqualTo(CameraOperationError.CAMERA_WARM_UP_FAILED);
        assertThat(receivedError.get().message()).isEqualTo("Camera disconnected");
    }

    @Test
    public void notifyPhotoCaptured_duplicateWhileMetadataPending_keepsTimeoutCompletingQueue()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest request =
                new QueuedPhotoRequest("/tmp/first.jpg", "large", false, true, null, callback);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, request);

        notifyPhotoCaptured(session, "/tmp/first.jpg");
        Runnable timeout = pendingCaptureMetadataTimeout(session);
        notifyPhotoCaptured(session, "/tmp/second.jpg");
        timeout.run();

        verify(callback).onPhotoCaptured(eq("/tmp/first.jpg"), (JSONObject) isNull());
        assertThat(activeCapture(session)).isNull();
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.IDLE);
        verify(hooks).startPostCaptureKeepAlive();
    }

    @Test
    public void notifyPhotoCaptured_hdrPathDoesNotWaitForMetadata_emitsImmediately()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest request =
                new QueuedPhotoRequest("/tmp/hdr.jpg", "large", false, true, null, callback);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, request);

        // HDR completion never records still metadata; it must not arm the wait timeout.
        notifyPhotoCaptured(session, "/tmp/hdr.jpg", false);

        verify(callback).onPhotoCaptured(eq("/tmp/hdr.jpg"), (JSONObject) isNull());
        assertThat(pendingCaptureMetadataTimeout(session)).isNull();
        assertThat(activeCapture(session)).isNull();
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.IDLE);
        verify(hooks).startPostCaptureKeepAlive();
    }

    @Test
    public void recordStillCaptureMetadata_staleGenerationIgnored_doesNotLeakToNextPhoto()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        PhotoSession session = new PhotoSession(hooks);

        // First shot activates; capture the generation its StillCaptureCallback would carry.
        QueuedPhotoRequest first =
                new QueuedPhotoRequest("/tmp/first.jpg", "large", false, true, null, null);
        activateQueuedRequest(session, first);
        long staleGeneration = captureMetadataGeneration(session);

        // Second shot begins, advancing the generation.
        QueuedPhotoRequest second =
                new QueuedPhotoRequest("/tmp/second.jpg", "large", false, true, null, callback);
        activateQueuedRequest(session, second);

        // A late completion from the first shot must be dropped, not stored for the second.
        JSONObject staleMetadata = new JSONObject().put("iso", 100);
        recordStillCaptureMetadata(session, staleGeneration, staleMetadata);
        assertThat(pendingStillCaptureMetadata(session)).isNull();

        // The second photo completes via timeout with no (stale) metadata attached.
        notifyPhotoCaptured(session, "/tmp/second.jpg");
        Runnable timeout = pendingCaptureMetadataTimeout(session);
        timeout.run();

        verify(callback).onPhotoCaptured(eq("/tmp/second.jpg"), (JSONObject) isNull());
    }

    private static PhotoSession.Hooks mockConfiguredCameraHooks() {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();
        CameraCoordinator coordinator = mock(CameraCoordinator.class);
        when(coordinator.hasConfiguredCamera()).thenReturn(true);
        when(coordinator.isCameraKeptAlive()).thenReturn(true);
        when(coordinator.device()).thenReturn(mock(CameraDevice.class));
        when(hooks.coordinator()).thenReturn(coordinator);
        Handler handler = mock(Handler.class);
        when(hooks.backgroundHandler()).thenReturn(handler);
        when(handler.postAtFrontOfQueue(any(Runnable.class)))
                .thenAnswer(
                        invocation -> {
                            ((Runnable) invocation.getArgument(0)).run();
                            return true;
                        });
        when(hooks.executor()).thenReturn(Runnable::run);
        when(hooks.capabilities()).thenReturn(null);
        when(hooks.cameraSettings()).thenReturn(null);
        when(hooks.previewBuilder()).thenReturn(null);
        return hooks;
    }

    private static void activateQueuedRequest(PhotoSession session, QueuedPhotoRequest request)
            throws Exception {
        Method load =
                PhotoSession.class.getDeclaredMethod(
                        "activateQueuedRequest", QueuedPhotoRequest.class);
        load.setAccessible(true);
        load.invoke(session, request);
    }

    private static void notifyPhotoCaptured(PhotoSession session, String filePath)
            throws Exception {
        Method notify = PhotoSession.class.getDeclaredMethod("notifyPhotoCaptured", String.class);
        notify.setAccessible(true);
        notify.invoke(session, filePath);
    }

    private static void notifyPhotoCaptured(
            PhotoSession session, String filePath, boolean waitForStillMetadata) throws Exception {
        Method notify =
                PhotoSession.class.getDeclaredMethod(
                        "notifyPhotoCaptured", String.class, boolean.class);
        notify.setAccessible(true);
        notify.invoke(session, filePath, waitForStillMetadata);
    }

    private static void recordStillCaptureMetadata(
            PhotoSession session, long generation, JSONObject metadata) throws Exception {
        Method record =
                PhotoSession.class.getDeclaredMethod(
                        "recordStillCaptureMetadata", long.class, JSONObject.class);
        record.setAccessible(true);
        record.invoke(session, generation, metadata);
    }

    private static long captureMetadataGeneration(PhotoSession session) throws Exception {
        Field field = PhotoSession.class.getDeclaredField("captureMetadataGeneration");
        field.setAccessible(true);
        return field.getLong(session);
    }

    private static JSONObject pendingStillCaptureMetadata(PhotoSession session) throws Exception {
        Field field = PhotoSession.class.getDeclaredField("pendingStillCaptureMetadata");
        field.setAccessible(true);
        return (JSONObject) field.get(session);
    }

    private static void clearActiveCapture(PhotoSession session) throws Exception {
        Field activeCaptureField = PhotoSession.class.getDeclaredField("activeCapture");
        activeCaptureField.setAccessible(true);
        activeCaptureField.set(session, null);
    }

    private static Object activeCapture(PhotoSession session) throws Exception {
        Field activeCaptureField = PhotoSession.class.getDeclaredField("activeCapture");
        activeCaptureField.setAccessible(true);
        return activeCaptureField.get(session);
    }

    private static Runnable pendingCaptureMetadataTimeout(PhotoSession session) throws Exception {
        Field pendingTimeoutField =
                PhotoSession.class.getDeclaredField("pendingCaptureMetadataTimeout");
        pendingTimeoutField.setAccessible(true);
        return (Runnable) pendingTimeoutField.get(session);
    }

    @Test
    public void startPreviewWithAeMonitoring_nullBackgroundHandler_doesNotCrash() throws Exception {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();
        CameraCoordinator coordinator = mock(CameraCoordinator.class);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        when(coordinator.session()).thenReturn(session);
        when(coordinator.device()).thenReturn(mock(CameraDevice.class));
        when(hooks.coordinator()).thenReturn(coordinator);
        when(hooks.backgroundHandler()).thenReturn(null);
        when(hooks.executor()).thenReturn(Runnable::run);

        PhotoSession photoSession = new PhotoSession(hooks);
        photoSession.startPreviewWithAeMonitoring();

        verify(hooks).closeCamera();
        verify(hooks).stopService();
        verify(session, never())
                .setRepeatingRequest(
                        any(CaptureRequest.class),
                        any(CameraCaptureSession.CaptureCallback.class),
                        any(Handler.class));
    }

    @Test
    public void restoreAePreview_nullBackgroundHandler_skipsSetRepeatingRequest() throws Exception {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        CameraCoordinator coordinator = mock(CameraCoordinator.class);
        when(coordinator.device()).thenReturn(mock(CameraDevice.class));
        when(hooks.coordinator()).thenReturn(coordinator);
        when(hooks.backgroundHandler()).thenReturn(null);

        PhotoSession photoSession = new PhotoSession(hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        photoSession.restoreAePreview(session);

        verify(session, never())
                .setRepeatingRequest(
                        any(CaptureRequest.class),
                        any(CameraCaptureSession.CaptureCallback.class),
                        any(Handler.class));
    }

    @Test
    public void capturePhoto_skipsWhenAlreadyShooting() throws Exception {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();
        when(hooks.coordinator()).thenReturn(mock(CameraCoordinator.class));
        when(hooks.executor()).thenReturn(mock(Executor.class));

        PhotoSession session = new PhotoSession(hooks);
        Field shotStateField = PhotoSession.class.getDeclaredField("shotState");
        shotStateField.setAccessible(true);
        shotStateField.set(session, AeStateMachine.ShotState.SHOOTING);

        session.capturePhoto();

        verify(hooks, never()).ensureImuRecorder();
    }

    @Test
    public void previewAndCaptureZsl_emptySettings_inheritGlobalDefault() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraSettings cameraSettings = new CameraSettings(RuntimeEnvironment.getApplication());
        when(hooks.cameraSettings()).thenReturn(cameraSettings);

        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/empty-zsl.jpg",
                        "medium",
                        false,
                        true,
                        null,
                        null,
                        PhotoCaptureSettings.EMPTY,
                        null));

        assertThat(session.previewZslMfnrEnabled()).isTrue();
        Method resolve =
                PhotoSession.class.getDeclaredMethod(
                        "resolveZslMfnrForCapture", boolean.class);
        resolve.setAccessible(true);
        assertThat(resolve.invoke(session, false)).isEqualTo(true);
        assertThat(resolve.invoke(session, true)).isEqualTo(false);
    }

    @Test
    public void resolveZslMfnrForCapture_manualExposureForcesOffWhenRequestEnabled()
            throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings enabled =
                new PhotoCaptureSettings.Builder().zslMfnr(true).build();
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/manual-zsl.jpg",
                        "medium",
                        false,
                        true,
                        10_000_000L,
                        100,
                        enabled,
                        null));

        Method resolve =
                PhotoSession.class.getDeclaredMethod(
                        "resolveZslMfnrForCapture", boolean.class);
        resolve.setAccessible(true);
        assertThat(resolve.invoke(session, true)).isEqualTo(false);
        assertThat(resolve.invoke(session, false)).isEqualTo(true);
    }

    @Test
    public void resolveZslMfnrForRequest_keepsEnabledWhenManualRequestedButUnsupported()
            throws Exception {
        // hooks.capabilities() is null in mockConfiguredCameraHooks — same as still capture
        // falling back to auto when MANUAL_SENSOR is unavailable.
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings enabled =
                new PhotoCaptureSettings.Builder().zslMfnr(true).build();
        PhotoSession session = new PhotoSession(hooks);

        Method resolve =
                PhotoSession.class.getDeclaredMethod(
                        "resolveZslMfnrForRequest",
                        PhotoCaptureSettings.class,
                        Long.class);
        resolve.setAccessible(true);
        assertThat(resolve.invoke(session, enabled, 10_000_000L)).isEqualTo(true);
        assertThat(session.willReuseConfiguredCamera("medium", true, 10_000_000L, enabled))
                .isFalse(); // no baseline yet
    }

    @Test
    public void onCameraClosed_quitsStillCaptureCallbackThread() throws Exception {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        Method handlerMethod =
                PhotoSession.class.getDeclaredMethod("stillCaptureCallbackHandler");
        handlerMethod.setAccessible(true);
        handlerMethod.invoke(session);

        Field threadField = PhotoSession.class.getDeclaredField("stillCaptureCallbackThread");
        threadField.setAccessible(true);
        android.os.HandlerThread thread =
                (android.os.HandlerThread) threadField.get(session);
        assertThat(thread).isNotNull();
        assertThat(thread.isAlive()).isTrue();

        session.onCameraClosed();

        assertThat(threadField.get(session)).isNull();
        Field handlerField =
                PhotoSession.class.getDeclaredField("stillCaptureCallbackHandler");
        handlerField.setAccessible(true);
        assertThat(handlerField.get(session)).isNull();
        thread.join(2000);
        assertThat(thread.isAlive()).isFalse();
    }
}
