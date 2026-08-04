package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

/** Plain JVM coverage for the exact four-byte BES firmware identity. */
public class BesOtaTargetVersionTest {

    @Test
    public void canonicalizesLeadingZeros() {
        assertThat(BesOtaAuthorizationGate.canonicalExactTargetVersion("017.026.007.024"))
                .isEqualTo("17.26.7.24");
    }

    @Test
    public void rejectsDisplaySuffixesAndOutOfRangeComponents() {
        assertThat(BesOtaAuthorizationGate.canonicalExactTargetVersion("17.26.7.24-fix1"))
                .isNull();
        assertThat(BesOtaAuthorizationGate.canonicalExactTargetVersion("17.26.7.256"))
                .isNull();
    }
}
