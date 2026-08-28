package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CaptureRequest;
import android.media.ImageReader;
import android.os.Handler;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.model.CameraOperationError;
import com.mentra.asg_client.camera.model.CapturedPhoto;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.camera.request.HdrBurstBuilder;
import com.mentra.asg_client.camera.request.StillCaptureBuilder;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
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
    public void exposureStabilizationDelay_appliesOnlyToColdDispatch() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoSession session = new PhotoSession(hooks);

        assertThat(session.minimumExposureStabilizationDelayMs())
                .isEqualTo(AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS);

        setBooleanField(session, "mCaptureDispatchedAsWarmReuse", true);
        assertThat(session.minimumExposureStabilizationDelayMs()).isZero();

        setBooleanField(session, "mCaptureDispatchedAsWarmReuse", false);
        when(hooks.coordinator().isCameraKeptAlive()).thenReturn(false);
        session.setupWarmUp(
                "large", null, PhotoCaptureSettings.EMPTY, 30_000, () -> {}, error -> {});
        assertThat(session.minimumExposureStabilizationDelayMs()).isZero();
    }

    @Test
    public void delayedExposureSettle_fromReplacedRequest_isIgnored() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest("/tmp/old.jpg", "large", false, true, null, null));
        setField(session, "shotState", AeStateMachine.ShotState.WAITING_AE);
        ArgumentCaptor<Runnable> delayedCapture = ArgumentCaptor.forClass(Runnable.class);

        session.scheduleCapturePhoto(475L);
        verify(hooks.backgroundHandler()).postDelayed(delayedCapture.capture(), eq(475L));

        activateQueuedRequest(
                session,
                new QueuedPhotoRequest("/tmp/new.jpg", "large", false, true, null, null));
        setField(session, "shotState", AeStateMachine.ShotState.WAITING_AE);
        delayedCapture.getValue().run();

        verify(hooks, never()).ensureImuRecorder();
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
    public void dispatchNextPhotoRequest_configuredCamera_previewBufferOffToOn_reopens()
            throws Exception {
        // Baseline has no preview-ZSL buffer; request needs one → must reopen.
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings bufferOff =
                new PhotoCaptureSettings.Builder().zsl(false).mfnr(false).build();
        PhotoCaptureSettings bufferOn =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(false).build();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest(
                        "/tmp/zsl-off.jpg", "large", false, true, null, null, bufferOff, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        QueuedPhotoRequestQueue.getInstance()
                .offer(
                        new QueuedPhotoRequest(
                                "/tmp/zsl-on.jpg",
                                "large",
                                false,
                                true,
                                null,
                                null,
                                bufferOn,
                                null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks).closeCamera();
        verify(hooks).openCameraInternal("/tmp/zsl-on.jpg", false);
    }

    @Test
    public void dispatchNextPhotoRequest_configuredCamera_mfnrToggleWithBufferKept_reuses()
            throws Exception {
        // Warm-up / prior shot had MFNR on (preview buffer armed). take_photo with MFNR off but
        // ZSL on still needs the same preview buffer — still-side MFNR is applied per capture,
        // so do NOT close+reopen (that was the warm→cold bug).
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings mfnrOn =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).build();
        PhotoCaptureSettings mfnrOff =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(false).build();
        QueuedPhotoRequest prior =
                new QueuedPhotoRequest(
                        "/tmp/mfnr-on.jpg", "large", false, true, null, null, mfnrOn, null);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, prior);
        clearActiveCapture(session);

        QueuedPhotoRequestQueue.getInstance()
                .offer(
                        new QueuedPhotoRequest(
                                "/tmp/mfnr-off.jpg",
                                "large",
                                false,
                                true,
                                null,
                                null,
                                mfnrOff,
                                null));

        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(hooks, never()).closeCamera();
        verify(hooks, never()).openCameraInternal(anyString(), eq(false));
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.WAITING_AE);
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
    public void notifyHostPhotoError_signalsFailureBeforeAsyncErrorDelivery() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        AtomicReference<Runnable> pendingError = new AtomicReference<>();
        when(hooks.executor()).thenReturn(pendingError::set);
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/failed.jpg", "large", false, true, null, callback));
        CameraOperationError error = CameraOperationError.captureFailed("capture failed");

        session.notifyHostPhotoError(error);

        verify(callback).onPhotoFailureDetected();
        verify(callback, never()).onPhotoError(error);
        assertThat(pendingError.get()).isNotNull();

        pendingError.get().run();
        verify(callback).onPhotoError(error);
    }

    @Test
    public void willReuseConfiguredCamera_matchesWarmUpZslMfnrBaseline() throws Exception {
        // Warm-up stores resolved zsl/mfnr in configuredCameraConfig; a later take_photo with the
        // same size/SDK/exposure must reuse even when still-side MFNR toggles (preview buffer stays).
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings warm =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(false).build();
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/warmup.jpg", "medium", false, true, null, null, warm, null));
        clearActiveCapture(session);

        assertThat(session.willReuseConfiguredCamera("medium", true, null, warm)).isTrue();
        assertThat(
                        session.willReuseConfiguredCamera(
                                "medium",
                                true,
                                null,
                                new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).build()))
                .isTrue();
        // Request needs no preview buffer while baseline has one — still reusable.
        assertThat(
                        session.willReuseConfiguredCamera(
                                "medium",
                                true,
                                null,
                                new PhotoCaptureSettings.Builder().zsl(false).mfnr(false).build()))
                .isTrue();
        // Size mismatch still forces reopen.
        assertThat(session.willReuseConfiguredCamera("high", true, null, warm)).isFalse();
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
    public void cancelWarmUp_clearsOpeningRequestAndAeWaitIdempotently() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        when(hooks.coordinator().isCameraKeptAlive()).thenReturn(false);
        PhotoSession session = new PhotoSession(hooks);
        session.setupWarmUp(
                "large", null, PhotoCaptureSettings.EMPTY, 30_000, () -> {}, error -> {});
        AeStateMachine aeStateMachine = aeStateMachine(session);
        aeStateMachine.beginWaitingForAe();

        assertThat(session.isWarmingUp()).isTrue();
        assertThat(session.cancelWarmUp()).isTrue();
        assertThat(session.isWarmingUp()).isFalse();
        assertThat(aeStateMachine.waitingForAeConvergence()).isFalse();
        assertThat(session.cancelWarmUp()).isFalse();
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.IDLE);

        // Simulate an AE callback that had already decided to dispatch before cancellation. It
        // must be ignored instead of starting a still capture with no active request.
        clearInvocations(hooks);
        Method onAeReady = PhotoSession.class.getDeclaredMethod("onAeReadyForActiveRequest");
        onAeReady.setAccessible(true);
        onAeReady.invoke(session);
        verify(hooks, never()).ensureImuRecorder();
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.IDLE);
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

        verify(callback)
                .onPhotoCaptured(
                        eq("/tmp/first.jpg"), (JSONObject) isNull(), (CapturedPhoto) isNull());
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

        verify(callback)
                .onPhotoCaptured(
                        eq("/tmp/hdr.jpg"), (JSONObject) isNull(), (CapturedPhoto) isNull());
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

        verify(callback)
                .onPhotoCaptured(
                        eq("/tmp/second.jpg"), (JSONObject) isNull(), (CapturedPhoto) isNull());
    }

    @Test
    public void notifyPhotoExposureStarted_staleGenerationDoesNotReachNextPhoto() throws Exception {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        CameraNeoService.PhotoCaptureCallback firstCallback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/first.jpg", "large", false, true, null, firstCallback));
        long staleGeneration = captureMetadataGeneration(session);

        CameraNeoService.PhotoCaptureCallback secondCallback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/second.jpg", "large", false, true, null, secondCallback));
        session.notifyPhotoExposureStartedForCapture(
                staleGeneration, firstCallback, 123L, 456L);

        verify(firstCallback, never()).onPhotoExposureStarted(123L, 456L);
        verify(secondCallback, never()).onPhotoExposureStarted(123L, 456L);

        session.notifyPhotoExposureStartedForCapture(
                captureMetadataGeneration(session), secondCallback, 123L, 456L);
        verify(secondCallback).onPhotoExposureStarted(123L, 456L);
    }

    @Test
    public void notifyPhotoCaptured_ramFirstCaptureSurvivesMetadataWait() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraNeoService.PhotoCaptureCallback callback =
                mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest request =
                new QueuedPhotoRequest("/tmp/ram.jpg", "large", false, true, null, callback);
        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(session, request);
        CapturedPhoto capturedPhoto =
                new CapturedPhoto(
                        new byte[] {1, 2, 3},
                        null,
                        CompletableFuture.completedFuture(false));

        notifyPhotoCaptured(session, "/tmp/ram.jpg", capturedPhoto);
        pendingCaptureMetadataTimeout(session).run();

        verify(callback)
                .onPhotoCaptured(eq("/tmp/ram.jpg"), (JSONObject) isNull(), eq(capturedPhoto));
    }

    @Test
    public void copyJsonPayload_isolatesRamCallbackFromPersistencePayload() throws Exception {
        JSONObject persistencePayload = new JSONObject().put("sampleCount", 2);
        Method copy =
                PhotoSession.class.getDeclaredMethod("copyJsonPayload", JSONObject.class);
        copy.setAccessible(true);

        JSONObject callbackPayload = (JSONObject) copy.invoke(null, persistencePayload);
        persistencePayload.put("sampleCount", 99);

        assertThat(callbackPayload).isNotSameAs(persistencePayload);
        assertThat(callbackPayload.optInt("sampleCount")).isEqualTo(2);
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
            PhotoSession session, String filePath, CapturedPhoto capturedPhoto) throws Exception {
        Method notify =
                PhotoSession.class.getDeclaredMethod(
                        "notifyPhotoCaptured", String.class, CapturedPhoto.class);
        notify.setAccessible(true);
        notify.invoke(session, filePath, capturedPhoto);
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

    private static AeStateMachine aeStateMachine(PhotoSession session) throws Exception {
        Field field = PhotoSession.class.getDeclaredField("aeStateMachine");
        field.setAccessible(true);
        return (AeStateMachine) field.get(session);
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

        assertThat(session.previewZslEnabled()).isTrue();
        Method resolveZsl = PhotoSession.class.getDeclaredMethod("resolveZslForCapture");
        resolveZsl.setAccessible(true);
        Method resolveMfnr = PhotoSession.class.getDeclaredMethod("resolveMfnrForCapture");
        resolveMfnr.setAccessible(true);
        assertThat(resolveZsl.invoke(session)).isEqualTo(true);
        assertThat(resolveMfnr.invoke(session)).isEqualTo(true);
    }

    @Test
    public void resolveZslAndMfnrForCapture_preservesRequestBeforeManualPolicy() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings enabled =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).build();
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

        Method resolveZsl = PhotoSession.class.getDeclaredMethod("resolveZslForCapture");
        resolveZsl.setAccessible(true);
        Method resolveMfnr = PhotoSession.class.getDeclaredMethod("resolveMfnrForCapture");
        resolveMfnr.setAccessible(true);
        assertThat(resolveZsl.invoke(session)).isEqualTo(true);
        assertThat(resolveMfnr.invoke(session)).isEqualTo(true);
        assertThat(StillCaptureBuilder.allowsVendorZslMfnr(true)).isFalse();
    }

    @Test
    public void resolveZslAndMfnrForRequest_honorsRequestFlags() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        PhotoCaptureSettings enabled =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).build();
        PhotoSession session = new PhotoSession(hooks);

        Method resolveZsl =
                PhotoSession.class.getDeclaredMethod(
                        "resolveZslForRequest", PhotoCaptureSettings.class);
        resolveZsl.setAccessible(true);
        Method resolveMfnr =
                PhotoSession.class.getDeclaredMethod(
                        "resolveMfnrForRequest", PhotoCaptureSettings.class);
        resolveMfnr.setAccessible(true);
        assertThat(resolveZsl.invoke(session, enabled)).isEqualTo(true);
        assertThat(resolveMfnr.invoke(session, enabled)).isEqualTo(true);
        assertThat(session.willReuseConfiguredCamera("medium", true, 10_000_000L, enabled))
                .isFalse(); // no baseline yet
    }

    @Test
    public void wouldCaptureHdrBurst_skipsManualExposureButtonCapture() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraSettings cameraSettings = new CameraSettings(RuntimeEnvironment.getApplication());
        cameraSettings.mAsgSettings.setHdrBurstEnabled(true);
        when(hooks.cameraSettings()).thenReturn(cameraSettings);

        com.mentra.asg_client.camera.policy.CameraCapabilities caps =
                new com.mentra.asg_client.camera.policy.CameraCapabilities(
                        new int[] {},
                        false,
                        0f,
                        true,
                        new android.util.Range<>(1_000L, 100_000_000L),
                        null,
                        new android.util.Range<>(100, 3200));
        when(hooks.capabilities()).thenReturn(caps);

        PhotoSession session = new PhotoSession(hooks);
        // Button (non-SDK) capture with manual exposure — HDR must not fire.
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/hdr-manual.jpg",
                        "medium",
                        false,
                        false,
                        10_000_000L,
                        100,
                        new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).build(),
                        null));
        assertThat(session.wouldCaptureHdrBurst()).isFalse();

        Method resolveZsl = PhotoSession.class.getDeclaredMethod("resolveZslForCapture");
        resolveZsl.setAccessible(true);
        Method resolveMfnr = PhotoSession.class.getDeclaredMethod("resolveMfnrForCapture");
        resolveMfnr.setAccessible(true);
        assertThat(resolveZsl.invoke(session)).isEqualTo(true);
        assertThat(resolveMfnr.invoke(session)).isEqualTo(true);
    }

    @Test
    public void wouldCaptureHdrBurst_allowsAutoExposureButtonCapture() throws Exception {
        PhotoSession.Hooks hooks = mockConfiguredCameraHooks();
        CameraSettings cameraSettings = new CameraSettings(RuntimeEnvironment.getApplication());
        cameraSettings.mAsgSettings.setHdrBurstEnabled(true);
        when(hooks.cameraSettings()).thenReturn(cameraSettings);

        PhotoSession session = new PhotoSession(hooks);
        activateQueuedRequest(
                session,
                new QueuedPhotoRequest(
                        "/tmp/hdr-auto.jpg", "medium", false, false, null, null));
        assertThat(session.wouldCaptureHdrBurst()).isTrue();
    }

    @Test
    public void shouldNotifyPhotoFrameAvailable_normalStillAllowsFrame() {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());

        assertThat(session.shouldNotifyPhotoFrameAvailable()).isTrue();
    }

    @Test
    public void shouldNotifyPhotoFrameAvailable_failedHdrSuppressesLateFrame() throws Exception {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        setBooleanField(session, "mCurrentShotUsesHdrBurst", true);

        assertThat(session.shouldNotifyPhotoFrameAvailable()).isFalse();
    }

    @Test
    public void shouldNotifyPhotoFrameAvailable_finalActiveHdrFrameAllowsFrame() throws Exception {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        setBooleanField(session, "mCurrentShotUsesHdrBurst", true);
        HdrBurstCapture hdrCapture = getField(session, "hdrBurstCapture", HdrBurstCapture.class);
        setBooleanField(hdrCapture, "active", true);
        setIntField(hdrCapture, "framesReceived", HdrBurstBuilder.HDR_BURST_COUNT - 1);

        assertThat(session.shouldNotifyPhotoFrameAvailable()).isTrue();
    }

    @Test
    public void acquireStillImage_activeHdrPreservesNextBracket() throws Exception {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        HdrBurstCapture hdrCapture = getField(session, "hdrBurstCapture", HdrBurstCapture.class);
        setBooleanField(hdrCapture, "active", true);
        ImageReader reader = mock(ImageReader.class);

        session.acquireStillImage(reader);

        verify(reader).acquireNextImage();
        verify(reader, never()).acquireLatestImage();
    }

    @Test
    public void acquireStillImage_normalStillDropsStaleFrames() {
        PhotoSession session = new PhotoSession(mockConfiguredCameraHooks());
        ImageReader reader = mock(ImageReader.class);

        session.acquireStillImage(reader);

        verify(reader).acquireLatestImage();
        verify(reader, never()).acquireNextImage();
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

    private static void setBooleanField(Object target, String name, boolean value)
            throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.setBoolean(target, value);
    }

    private static void setField(Object target, String name, Object value)
            throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static void setIntField(Object target, String name, int value)
            throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.setInt(target, value);
    }

    private static <T> T getField(Object target, String name, Class<T> type)
            throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return type.cast(field.get(target));
    }
}
