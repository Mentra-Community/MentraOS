package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.Handler;

import com.mentra.asg_client.camera.model.PhotoRequest;
import com.mentra.asg_client.camera.model.PhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.lang.reflect.Field;
import java.util.concurrent.Executor;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoSessionTest {

    @Before
    @After
    public void drainQueue() {
        PhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @Test
    public void dispatchNextPhotoRequest_idleWithConfiguredCamera_loadsRequestAndPosts() {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();
        CameraCoordinator coordinator = mock(CameraCoordinator.class);
        when(coordinator.hasConfiguredCamera()).thenReturn(true);
        when(hooks.coordinator()).thenReturn(coordinator);
        Handler handler = mock(Handler.class);
        when(hooks.backgroundHandler()).thenReturn(handler);
        when(handler.postAtFrontOfQueue(any(Runnable.class))).thenAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return true;
        });
        when(hooks.executor()).thenReturn(Runnable::run);
        when(hooks.capabilities()).thenReturn(null);
        when(hooks.cameraSettings()).thenReturn(null);
        when(hooks.previewBuilder()).thenReturn(null);

        PhotoRequestQueue.getInstance().offer(
                new PhotoRequest("/tmp/p.jpg", "medium", false, true, null, null));

        PhotoSession session = new PhotoSession(hooks);
        session.dispatchNextPhotoRequest();

        verify(hooks).cancelKeepAliveTimer();
        verify(handler).postAtFrontOfQueue(any(Runnable.class));
        assertThat(session.shotState()).isEqualTo(AeStateMachine.ShotState.WAITING_AE);
    }

    @Test
    public void dispatchNextPhotoRequest_emptyQueue_startsKeepAlive() {
        PhotoSession.Hooks hooks = mock(PhotoSession.Hooks.class);
        doReturn(new Object()).when(hooks).serviceLock();

        PhotoSession session = new PhotoSession(hooks);
        session.dispatchNextPhotoRequest();

        verify(hooks).startKeepAliveTimer();
        verify(hooks, never()).cancelKeepAliveTimer();
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
}
