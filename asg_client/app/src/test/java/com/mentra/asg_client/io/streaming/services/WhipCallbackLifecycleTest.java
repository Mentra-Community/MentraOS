package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.assertSame;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.io.streaming.config.IcePostPolicy;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import org.webrtc.PeerConnection;

/** Exercises callback queueing against the real service, without opening camera or network. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class WhipCallbackLifecycleTest {
  private Field field(String name) throws Exception {
    Field field = WhipStreamingService.class.getDeclaredField(name);
    field.setAccessible(true);
    return field;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private WhipStreamingService service(String state) throws Exception {
    WhipStreamingService service = mock(WhipStreamingService.class, CALLS_REAL_METHODS);
    field("mStateLock").set(service, new Object());
    field("mMainHandler").set(service, new Handler(Looper.getMainLooper()));
    field("mIceMode").set(service, IcePostPolicy.Mode.HOST_ONLY);
    field("mNegotiationGeneration").set(service, 1);
    field("mStreamState").set(service, Enum.valueOf((Class) field("mStreamState").getType(), state));
    return service;
  }

  private void postOffer(WhipStreamingService service, int generation) throws Exception {
    Method method = WhipStreamingService.class.getDeclaredMethod("postOfferIfReady", String.class, int.class);
    method.setAccessible(true);
    method.invoke(service, "complete", generation);
  }

  @Test
  public void queuedGatherCompleteCannotFailReplacementPeer() throws Exception {
    WhipStreamingService service = service("STARTING");
    PeerConnection replacement = mock(PeerConnection.class);
    field("mPeerConnection").set(service, replacement);
    Class<?> observerType = Class.forName(WhipStreamingService.class.getName() + "$WhipPeerConnectionObserver");
    Constructor<?> constructor = observerType.getDeclaredConstructor(WhipStreamingService.class, int.class);
    constructor.setAccessible(true);
    PeerConnection.Observer observer = (PeerConnection.Observer) constructor.newInstance(service, 1);
    Thread worker = new Thread(() -> observer.onIceGatheringChange(PeerConnection.IceGatheringState.COMPLETE));
    worker.start();
    worker.join();
    // Rejoin overtakes the main-thread runnable after the observer's first generation check.
    field("mNegotiationGeneration").set(service, 2);
    shadowOf(Looper.getMainLooper()).idle();
    assertSame(replacement, field("mPeerConnection").get(service));
    verifyNoInteractions(replacement);
  }

  @Test
  public void gatherCompleteCannotFailStoppedOrAlreadyPublishedStream() throws Exception {
    for (String state : new String[] {"IDLE", "STOPPING", "STARTING"}) {
      WhipStreamingService service = service(state);
      PeerConnection peer = mock(PeerConnection.class);
      field("mPeerConnection").set(service, peer);
      field("mWhipOfferPosted").set(service, state.equals("STARTING"));
      postOffer(service, 1);
      assertSame(peer, field("mPeerConnection").get(service));
      verifyNoInteractions(peer);
    }
  }
}
