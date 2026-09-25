package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.Test;

public class PhonePresenceReportTest {
    @Test public void acceptsOnlyNumericZeroAndOne() {
        assertThat(PhonePresenceReport.parse(0)).isFalse();
        assertThat(PhonePresenceReport.parse(1)).isTrue();
        assertThat(PhonePresenceReport.parse(1.0)).isTrue();
        for (Object malformed : new Object[] {null, "1", "no", true, 2, -1, 0.5, Double.NaN}) {
            assertThat(PhonePresenceReport.parse(malformed)).isNull();
        }
    }
}
