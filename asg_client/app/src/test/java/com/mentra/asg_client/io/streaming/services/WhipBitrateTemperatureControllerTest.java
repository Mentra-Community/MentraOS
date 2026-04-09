package com.mentra.asg_client.io.streaming.services;

import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;

import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(org.junit.runners.JUnit4.class)
public class WhipBitrateTemperatureControllerTest {

  @Test
  public void temperaturesBelowControlStartKeepRequestedBitrate() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoWidth(960)
        .setVideoHeight(540)
        .setVideoFps(15)
        .setVideoBitrate(4_000_000);

    controller.reset(requestedConfig);
    WhipBitrateTemperatureController.BitrateDecision decision =
        controller.update(86_000, requestedConfig);

    Assert.assertEquals(4_000_000, decision.getTargetBitrateBps());
    Assert.assertFalse(decision.isThermallyLimited());
  }

  @Test
  public void hotterTemperaturesReduceBitrateProgressively() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoBitrate(4_000_000);

    controller.reset(requestedConfig);
    int warmBitrate = controller.update(88_000, requestedConfig).getTargetBitrateBps();
    int hotBitrate = controller.update(89_200, requestedConfig).getTargetBitrateBps();

    Assert.assertTrue(warmBitrate < 4_000_000);
    Assert.assertTrue(hotBitrate < warmBitrate);
  }

  @Test
  public void highEightiesAtTwentyFpsKeepsAtLeastOneMbps() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoWidth(720)
        .setVideoHeight(480)
        .setVideoFps(20)
        .setVideoBitrate(2_000_000);

    controller.reset(requestedConfig);
    WhipBitrateTemperatureController.BitrateDecision decision =
        controller.update(87_000, requestedConfig);

    Assert.assertTrue(decision.getTargetBitrateBps() >= 1_000_000);
  }

  @Test
  public void emergencyStartsBeforeNinetyC() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoBitrate(4_000_000);

    controller.reset(requestedConfig);
    WhipBitrateTemperatureController.BitrateDecision decision =
        controller.update(89_700, requestedConfig);

    Assert.assertTrue(decision.isHardLimitActive());
    Assert.assertTrue(decision.getTargetBitrateBps() <= 700_000);
  }

  @Test
  public void controllerUsesRequestedBitrateAsItsBaseline() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig lowerBitrateConfig = new WhipStreamConfig()
        .setVideoBitrate(1_000_000);
    WhipStreamConfig higherBitrateConfig = new WhipStreamConfig()
        .setVideoBitrate(3_000_000);

    controller.reset(lowerBitrateConfig);
    int lowerTarget = controller.update(88_000, lowerBitrateConfig).getTargetBitrateBps();

    controller.reset(higherBitrateConfig);
    int higherTarget = controller.update(88_000, higherBitrateConfig).getTargetBitrateBps();

    Assert.assertTrue(higherTarget > lowerTarget);
    Assert.assertTrue(lowerTarget <= 1_000_000);
    Assert.assertTrue(higherTarget <= 3_000_000);
  }

  @Test
  public void hardLimitAtNinetyCTriggersAggressiveReduction() {
    WhipBitrateTemperatureController controller = new WhipBitrateTemperatureController();
    WhipStreamConfig requestedConfig = new WhipStreamConfig()
        .setVideoBitrate(4_000_000);

    controller.reset(requestedConfig);
    WhipBitrateTemperatureController.BitrateDecision decision =
        controller.update(90_000, requestedConfig);

    Assert.assertTrue(decision.isHardLimitActive());
    Assert.assertTrue(decision.getTargetBitrateBps() <= 300_000);
  }

  @Test
  public void smoothingStillDampensTemperatureSpikes() {
    int smoothed = WhipThermalQualityProfile.smoothCpuTemperature(89_000, 90_400);

    Assert.assertTrue(smoothed > 89_000);
    Assert.assertTrue(smoothed < 90_400);
  }

}
