package com.mentra.bluetoothsdk.photoreceiver;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.After;
import org.junit.Test;

public class LocalPhotoReceiverRegistryTest {

    @After
    public void tearDown() {
        LocalPhotoReceiverRegistry.unregister();
    }

    @Test
    public void loopbackUploadUrlFor_rewritesRegisteredReceiverUrl() {
        LocalPhotoReceiverRegistry.register("http://192.168.1.20:8787/upload");

        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://192.168.1.20:8787/upload"))
                .isEqualTo("http://127.0.0.1:8787/upload");
    }

    @Test
    public void loopbackUploadUrlFor_doesNotRewriteDifferentHostOnSamePort() {
        LocalPhotoReceiverRegistry.register("http://192.168.1.20:8787/upload");

        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("https://api.example.com:8787/upload"))
                .isNull();
        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://devbox:8787/upload"))
                .isNull();
    }

    @Test
    public void loopbackUploadUrlFor_doesNotRewriteDifferentPath() {
        LocalPhotoReceiverRegistry.register("http://192.168.1.20:8787/upload");

        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://192.168.1.20:8787/other"))
                .isNull();
    }

    @Test
    public void loopbackUploadUrlFor_keepsEarlierReceiverUrlsUntilUnregister() {
        LocalPhotoReceiverRegistry.register("http://192.168.1.20:8787/upload");
        LocalPhotoReceiverRegistry.register("http://10.0.0.12:8787/upload");

        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://192.168.1.20:8787/upload"))
                .isEqualTo("http://127.0.0.1:8787/upload");
        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://10.0.0.12:8787/upload"))
                .isEqualTo("http://127.0.0.1:8787/upload");

        LocalPhotoReceiverRegistry.unregister();

        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://192.168.1.20:8787/upload"))
                .isNull();
    }

    @Test
    public void register_keepsExistingReceiverUrlsWhenInvalidUrlArrives() {
        LocalPhotoReceiverRegistry.register("http://192.168.1.20:8787/upload");
        LocalPhotoReceiverRegistry.register("not a url");

        assertThat(LocalPhotoReceiverRegistry.isActive()).isTrue();
        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("http://192.168.1.20:8787/upload"))
                .isEqualTo("http://127.0.0.1:8787/upload");
    }

    @Test
    public void register_rejectsInvalidReceiverUrl() {
        LocalPhotoReceiverRegistry.register("https://api.example.com/photo");

        assertThat(LocalPhotoReceiverRegistry.isActive()).isFalse();
        assertThat(LocalPhotoReceiverRegistry.loopbackUploadUrlFor("https://api.example.com/photo"))
                .isNull();
    }
}
