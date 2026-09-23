package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

/** Confirms bounded handshake visibility without repairing or clearing the parser under test. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaHandshakeDiagnosticsTest {
    private BesOtaManager manager;

    @Before
    public void setUp() throws Exception {
        BesOtaManager.isBesOtaInProgress = false;
        manager = new BesOtaManager(null, null, ApplicationProvider.getApplicationContext());
        Field owner = BesOtaManager.class.getDeclaredField("activeOwnerSessionId");
        owner.setAccessible(true);
        owner.set(manager, "diagnostic-test-owner");
        ShadowLog.clear();
    }

    @After
    public void tearDown() {
        BesOtaManager.isBesOtaInProgress = false;
    }

    @Test
    public void retainedPartialReplyIsVisibleAndRemainsUnchanged() throws Exception {
        manager.parseRecv(new byte[] {(byte) 0x9a, 4, 0}, 0, 3);
        begin();
        assertThat(logs("raw_entry").get(0)).contains("owner=diagnostic-test-owner", "buffered=3");

        manager.onOtaRecv(versionReply(), 9);

        assertThat(logs("raw_receive").get(0))
                .contains(
                        "buffered_before=3",
                        "buffered_after=12",
                        "chunk_prefix=9a 04 00 00 00",
                        "header=9a 04 00 9a 04",
                        "declared_length=77201412",
                        "disposition=incomplete");
        assertThat(manager.parseRecv(versionReply(), 0, 9)).isNull();
    }

    @Test
    public void validVersionReplyStopsLoggingAndDoesNotStartAnInactiveTransfer() throws Exception {
        begin();
        manager.onOtaRecv(versionReply(), 9);
        manager.onOtaRecv(versionReply(), 9);

        assertThat(logs("raw_receive")).hasSize(1);
        assertThat(logs("raw_receive").get(0))
                .contains("declared_length=4", "buffered_after=0", "disposition=parsed");
        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
    }

    @Test
    public void malformedHandshakeLoggingIsCappedAndDoesNotExposeTheBody() throws Exception {
        begin();
        byte[] incomplete = new byte[30];
        incomplete[0] = (byte) 0x9a;
        incomplete[1] = (byte) 0xff;
        incomplete[2] = (byte) 0xff;
        java.util.Arrays.fill(incomplete, 5, incomplete.length, (byte) 0x5a);
        for (int i = 0; i < AsgConstants.BES_OTA_HANDSHAKE_DIAGNOSTIC_MAX_FRAMES + 2; i++) {
            manager.onOtaRecv(incomplete, incomplete.length);
        }

        assertThat(logs("raw_receive"))
                .hasSize(AsgConstants.BES_OTA_HANDSHAKE_DIAGNOSTIC_MAX_FRAMES);
        assertThat(String.join("\n", logs("raw_receive"))).doesNotContain("5a");
    }

    @Test
    public void cleanupStopsDiagnostics() throws Exception {
        begin();
        Method cleanup = BesOtaManager.class.getDeclaredMethod("cleanup");
        cleanup.setAccessible(true);
        cleanup.invoke(manager);
        manager.onOtaRecv(versionReply(), 9);
        assertThat(logs("raw_receive")).isEmpty();
    }

    private void begin() throws Exception {
        Method begin =
                BesOtaManager.class.getDeclaredMethod("beginHandshakeDiagnostics", String.class);
        begin.setAccessible(true);
        begin.invoke(manager, "test");
    }

    private List<String> logs(String operation) {
        return ShadowLog.getLogsForTag("BesOtaManager").stream()
                .map(item -> item.msg)
                .filter(message -> message.startsWith("BES_OTA_DIAG op=" + operation))
                .collect(Collectors.toList());
    }

    private static byte[] versionReply() {
        return new byte[] {(byte) 0x9a, 4, 0, 0, 0, 0, 0, 0, 1};
    }
}
