package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.utils.FirmwareDownloadException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperBesDownloadProgressTest {
    private OtaHelper helper;

    private OtaHelper.PhoneConnectionProvider prepare() {
        helper = new OtaHelper(ApplicationProvider.getApplicationContext(), mock(IBesOtaRegistry.class));
        helper.getSessionManager().clear();
        helper.getSessionManager().createSession(new String[]{"apk", "bes"}, "https://cdn/manifest.json");
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        return phone;
    }

    @After public void cleanup() {
        if (helper != null) {
            helper.getSessionManager().clear();
            helper.cleanup();
        }
    }

    @Test public void downloadedBytesUpdateTheOwningBesStepBeforeVerification() throws Exception {
        OtaHelper.PhoneConnectionProvider phone = prepare();
        byte[] bytes = new byte[8192];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        assertThat(helper.copyBesFirmwareDownload(new ByteArrayInputStream(bytes), out, bytes.length)).isEqualTo(8192);
        assertThat(out.toByteArray()).isEqualTo(bytes);
        JSONObject state = helper.getSessionManager().getSessionState();
        assertThat(state.getString("st")).isEqualTo("bes");
        assertThat(state.getInt("cs")).isEqualTo(2);
        assertThat(state.getLong("bytes_downloaded")).isEqualTo(8192);
        assertThat(state.getInt("sp")).isEqualTo(99);
        assertThat(state.getString("status")).isEqualTo("in_progress");
        ArgumentCaptor<JSONObject> statuses = ArgumentCaptor.forClass(JSONObject.class);
        verify(phone, atLeast(2)).sendOtaStatus(statuses.capture());
        assertThat(statuses.getAllValues().stream().anyMatch(s -> s.optLong("bytes_downloaded") > 0)).isTrue();
    }

    @Test public void unknownLengthStillPublishesByteLiveness() throws Exception {
        prepare();
        helper.copyBesFirmwareDownload(new ByteArrayInputStream(new byte[8192]), new ByteArrayOutputStream(), -1);
        JSONObject state = helper.getSessionManager().getSessionState();
        assertThat(state.getLong("bytes_downloaded")).isEqualTo(8192);
        assertThat(state.getInt("sp")).isZero();
        assertThat(state.getInt("op")).isEqualTo(20);
        assertThat(state.getString("phase")).isEqualTo("download");
    }

    @Test public void oversizedStreamsAreRejectedBeforeWritingPastTheCap() throws Exception {
        prepare();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        org.junit.Assert.assertThrows(FirmwareDownloadException.class, () ->
                helper.copyBesFirmwareDownload(new ByteArrayInputStream(new byte[2 * 1024 * 1024 + 1]), out, -1));
        assertThat(out.size()).isEqualTo(2 * 1024 * 1024);
        assertThat(helper.getSessionManager().getSessionState().getString("status")).isEqualTo("in_progress");
    }
}
