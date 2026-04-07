package com.mentra.asg_client.io.streaming.services;

import android.os.PowerManager;

import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;

import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(org.junit.runners.JUnit4.class)
public class WhipThermalQualityProfileTest {

  @Test
  public void moderateThermalsPreferBitrateReductionOnly() {
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoWidth(960)
        .setVideoHeight(540)
        .setVideoFps(15)
        .setVideoBitrate(1_000_000);

    WhipStreamConfig adjustedConfig = WhipThermalQualityProfile.buildConfig(
        requestedConfig, WhipThermalQualityProfile.Tier.WARM);

    Assert.assertEquals(960, adjustedConfig.getVideoWidth());
    Assert.assertEquals(540, adjustedConfig.getVideoHeight());
    Assert.assertEquals(15, adjustedConfig.getVideoFps());
    Assert.assertEquals(700_000, adjustedConfig.getVideoBitrate());
  }

  @Test
  public void severeThermalsReduceAllVideoKnobs() {
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoWidth(960)
        .setVideoHeight(540)
        .setVideoFps(15)
        .setVideoBitrate(1_000_000);

    WhipStreamConfig adjustedConfig = WhipThermalQualityProfile.buildConfig(
        requestedConfig, WhipThermalQualityProfile.Tier.HOT);

    Assert.assertEquals(640, adjustedConfig.getVideoWidth());
    Assert.assertEquals(360, adjustedConfig.getVideoHeight());
    Assert.assertEquals(12, adjustedConfig.getVideoFps());
    Assert.assertEquals(500_000, adjustedConfig.getVideoBitrate());
  }

  @Test
  public void criticalThermalsUseMostAggressiveProfile() {
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoWidth(960)
        .setVideoHeight(540)
        .setVideoFps(15)
        .setVideoBitrate(1_000_000);

    WhipStreamConfig adjustedConfig = WhipThermalQualityProfile.buildConfig(
        requestedConfig, WhipThermalQualityProfile.Tier.CRITICAL);

    Assert.assertEquals(480, adjustedConfig.getVideoWidth());
    Assert.assertEquals(270, adjustedConfig.getVideoHeight());
    Assert.assertEquals(10, adjustedConfig.getVideoFps());
    Assert.assertEquals(350_000, adjustedConfig.getVideoBitrate());
  }

  @Test
  public void thermalStatusMappingEscalatesAtModerateAndAbove() {
    Assert.assertEquals(WhipThermalQualityProfile.Tier.NORMAL,
        WhipThermalQualityProfile.fromThermalStatus(PowerManager.THERMAL_STATUS_LIGHT));
    Assert.assertEquals(WhipThermalQualityProfile.Tier.WARM,
        WhipThermalQualityProfile.fromThermalStatus(PowerManager.THERMAL_STATUS_MODERATE));
    Assert.assertEquals(WhipThermalQualityProfile.Tier.HOT,
        WhipThermalQualityProfile.fromThermalStatus(PowerManager.THERMAL_STATUS_SEVERE));
    Assert.assertEquals(WhipThermalQualityProfile.Tier.CRITICAL,
        WhipThermalQualityProfile.fromThermalStatus(PowerManager.THERMAL_STATUS_EMERGENCY));
  }
}
