package com.mentra.asg_client.io.ota.services;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class OtaServiceHotspotResumeTest {
    @Test
    public void apkOnlyHotspotRestartDoesNotRequireAdoption() {
        assertThat(OtaService.requiresHotspotRestartAdoption("hotspot", 1, 1)).isFalse();
    }

    @Test
    public void multiStepHotspotRestartRequiresAdoption() {
        assertThat(OtaService.requiresHotspotRestartAdoption("hotspot", 1, 3)).isTrue();
    }

    @Test
    public void wifiRestartNeverRequiresHotspotAdoption() {
        assertThat(OtaService.requiresHotspotRestartAdoption("wifi", 1, 3)).isFalse();
    }
}
