package com.mentra.asg_client.service.legacy.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.NetworkUtils;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.server.core.DefaultServerFactory;
import com.mentra.asg_client.io.server.services.AsgCameraServer;
import com.mentra.asg_client.io.server.managers.AsgServerManager;
import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.settings.AsgSettings;
import java.lang.reflect.Field;
import java.time.Duration;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class PersistentGalleryServerTest {
    private Application context;
    private AsgSettings settings;
    private INetworkManager network;
    private AsgClientServiceManager manager;
    private MockedStatic<DefaultServerFactory> factory;
    private MockedStatic<NetworkUtils> addresses;
    private AsgCameraServer server;
    private AsgCameraServer hotspotServer;

    @Before
    public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        settings = new AsgSettings(context);
        network = mock(INetworkManager.class);
        manager = new AsgClientServiceManager(context, mock(AsgClientService.class),
                mock(ICommunicationManager.class), mock(FileManager.class),
                mock(IBesOtaRegistry.class), mock(ICompanionTransport.class), network);
        setField("asgSettings", settings);
        setField("mediaCaptureService", mock(MediaCaptureService.class));
        factory = mockStatic(DefaultServerFactory.class);
        addresses = mockStatic(NetworkUtils.class);
        server = mock(AsgCameraServer.class);
        when(server.startServer()).thenReturn(true);
        when(server.isAlive()).thenReturn(true);
        when(server.getListeningPort()).thenReturn(8089);
        hotspotServer = mock(AsgCameraServer.class);
        when(hotspotServer.startServer()).thenReturn(true);
        when(hotspotServer.isAlive()).thenReturn(true);
        when(hotspotServer.getHostname()).thenReturn("192.168.43.1");
        when(network.getHotspotGatewayIp()).thenReturn("192.168.43.1");
        AsgServerManager servers = mock(AsgServerManager.class);
        when(servers.stopServer("camera")).thenAnswer(call -> {
            manager.getCameraServer().stopServer();
            return true;
        });
        setField("serverManager", servers);
        factory.when(DefaultServerFactory::createLogger).thenReturn(mock(Logger.class));
        when(network.isConnectedToWifi()).thenReturn(true);
        addresses.when(() -> NetworkUtils.getWifiIpAddress(context)).thenReturn("10.1.2.3");
        factory.when(() -> DefaultServerFactory.createCameraWebServer(
                eq(8089), eq("CameraWebServer"), eq(context), any(), any())).thenReturn(server);
        factory.when(() -> DefaultServerFactory.createHotspotCameraWebServer(
                eq(8089), eq("CameraWebServer"), eq(context), any(), any(), eq("192.168.43.1")))
                .thenReturn(hotspotServer);
    }

    @After
    public void tearDown() {
        manager.cleanup();
        factory.close();
        addresses.close();
    }

    @Test
    public void defaultOffAndExplicitOptInSurvivesSettingsRecreation() {
        manager.reconcileGalleryServer();
        assertThat(manager.isGalleryServerEnabled()).isFalse();
        verify(server, never()).startServer();

        assertThat(manager.setGalleryServerEnabled(true)).isTrue();
        assertThat(new AsgSettings(context).isGalleryServerEnabled()).isTrue();
        assertThat(manager.getGalleryServerUrl()).isEqualTo("http://10.1.2.3:8089");
        // Unrelated hotspot disable must not terminate the persistent station server.
        manager.setWebServerEnabled(false);
        verify(server, never()).stopServer();

        manager.setGalleryServerEnabled(false);
        assertThat(new AsgSettings(context).isGalleryServerEnabled()).isFalse();
        assertThat(manager.getGalleryServerUrl()).isNull();
        verify(server).stopServer();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10));
        verify(server, times(1)).startServer();
    }

    @Test
    public void savedOptInStartsWithoutWifiAndRemainsRunningAcrossReconnects() {
        settings.setGalleryServerEnabled(true);
        when(network.isConnectedToWifi()).thenReturn(false);
        manager.reconcileGalleryServer();
        verify(server).startServer();
        assertThat(manager.getGalleryServerUrl()).isNull();

        when(network.isConnectedToWifi()).thenReturn(true);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
        assertThat(manager.getGalleryServerUrl()).isEqualTo("http://10.1.2.3:8089");

        when(network.isConnectedToWifi()).thenReturn(false);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
        verify(server, never()).stopServer();
        assertThat(manager.getGalleryServerUrl()).isNull();
        assertThat(manager.isGalleryServerEnabled()).isTrue();
    }

    @Test
    public void repeatedEnableAndDhcpChangeKeepTheSameServer() {
        manager.setGalleryServerEnabled(true);
        manager.setGalleryServerEnabled(true);
        addresses.when(() -> NetworkUtils.getWifiIpAddress(context)).thenReturn("10.1.2.4");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
        verify(server, times(1)).startServer();
        verify(server, never()).stopServer();
        assertThat(manager.getGalleryServerUrl()).isEqualTo("http://10.1.2.4:8089");
    }

    @Test
    public void failedBindRetriesWithoutClaimingAnAvailableEndpoint() {
        when(server.startServer()).thenReturn(false, true);
        manager.setGalleryServerEnabled(true);
        assertThat(manager.getGalleryServerUrl()).isNull();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
        assertThat(manager.getGalleryServerUrl()).isNotNull();
    }

    @Test
    public void failedEnableCannotStartPersistentServerOnLaterReconciliation() throws Exception {
        Context failingStorage = failPreferenceWrites();

        assertThat(manager.setGalleryServerEnabled(true)).isFalse();
        assertThat(manager.isGalleryServerEnabled()).isFalse();
        assertThat(new AsgSettings(failingStorage).isGalleryServerEnabled()).isFalse();
        assertThat(manager.getGalleryServerUrl()).isNull();
        manager.reconcileGalleryServer();
        when(network.isHotspotEnabled()).thenReturn(true);
        manager.setWebServerEnabled(true);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10));

        verify(server, never()).startServer();
        assertThat(manager.getCameraServer()).isSameAs(hotspotServer);
    }

    @Test
    public void failedDisablePreservesThePreviouslySavedSettingAndListener() throws Exception {
        manager.setGalleryServerEnabled(true);
        Context failingStorage = failPreferenceWrites();

        assertThat(manager.setGalleryServerEnabled(false)).isFalse();
        assertThat(manager.isGalleryServerEnabled()).isTrue();
        assertThat(new AsgSettings(failingStorage).isGalleryServerEnabled()).isTrue();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10));

        assertThat(manager.getGalleryServerUrl()).isEqualTo("http://10.1.2.3:8089");
        verify(server, times(1)).startServer();
        verify(server, never()).stopServer();
    }

    private Context failPreferenceWrites() throws Exception {
        SharedPreferences backing = context.getSharedPreferences("asg_settings", Context.MODE_PRIVATE);
        SharedPreferences preferences = mock(SharedPreferences.class, delegatesTo(backing));
        doAnswer(call -> {
            SharedPreferences.Editor backingEditor = backing.edit();
            SharedPreferences.Editor editor = mock(SharedPreferences.Editor.class);
            doAnswer(commit -> {
                // Reproduce Android's in-memory mutation before reporting a failed write,
                // including failure of the rollback write itself.
                backingEditor.commit();
                return false;
            }).when(editor).commit();
            doAnswer(put -> {
                backingEditor.putBoolean(put.getArgument(0), put.getArgument(1));
                return editor;
            }).when(editor).putBoolean(anyString(), anyBoolean());
            return editor;
        }).when(preferences).edit();
        Context failingStorage = new ContextWrapper(context) {
            @Override
            public SharedPreferences getSharedPreferences(String name, int mode) {
                return preferences;
            }
        };
        settings = new AsgSettings(failingStorage);
        setField("asgSettings", settings);
        return failingStorage;
    }

    @Test
    public void toggleRebindsTheSameApiBetweenHotspotAndPersistentModes() {
        when(network.isHotspotEnabled()).thenReturn(true);
        manager.setWebServerEnabled(true);
        assertThat(manager.getCameraServer()).isSameAs(hotspotServer);

        manager.setGalleryServerEnabled(true);
        verify(hotspotServer).stopServer();
        assertThat(manager.getCameraServer()).isSameAs(server);

        manager.setGalleryServerEnabled(false);
        verify(server).stopServer();
        assertThat(manager.getCameraServer()).isSameAs(hotspotServer);
        assertThat(manager.getGalleryServerUrl()).isNull();
        verify(hotspotServer, times(2)).startServer();
    }

    @Test
    public void persistentModeWiresTheExistingCameraCaptureCallback() throws Exception {
        MediaCaptureService media = mock(MediaCaptureService.class);
        setField("mediaCaptureService", media);
        manager.setGalleryServerEnabled(true);
        org.mockito.ArgumentCaptor<AsgCameraServer.OnPictureRequestListener> capture =
                org.mockito.ArgumentCaptor.forClass(AsgCameraServer.OnPictureRequestListener.class);
        verify(server).setOnPictureRequestListener(capture.capture());
        capture.getValue().onPictureRequest();
        verify(media).takePhotoLocally();
    }

    @Test
    public void cleanupCancelsRetriesWithoutClearingSavedOptIn() {
        manager.setGalleryServerEnabled(true);
        manager.cleanup();
        manager.reconcileGalleryServer();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10));
        verify(server, times(1)).startServer();
        verify(server, times(1)).stopServer();
        assertThat(new AsgSettings(context).isGalleryServerEnabled()).isTrue();
        assertThat(manager.getGalleryServerUrl()).isNull();
    }

    private void setField(String name, Object value) throws Exception {
        Field field = AsgClientServiceManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(manager, value);
    }
}
