package com.mentra.asg_client.io.streaming.services;

import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(org.junit.runners.JUnit4.class)
public class StreamingBitrateTemperatureControllerTest {

  @Test
  public void temperaturesBelowControlStartKeepRequestedBitrate() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(4_000_000);
    StreamingBitrateTemperatureController.BitrateDecision decision =
        controller.update(86_000, 4_000_000);

    Assert.assertEquals(4_000_000, decision.getTargetBitrateBps());
    Assert.assertFalse(decision.isThermallyLimited());
  }

  @Test
  public void hotterTemperaturesReduceBitrateProgressively() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(4_000_000);
    int warmBitrate = controller.update(88_000, 4_000_000).getTargetBitrateBps();
    int hotBitrate = controller.update(89_200, 4_000_000).getTargetBitrateBps();

    Assert.assertTrue(warmBitrate < 4_000_000);
    Assert.assertTrue(hotBitrate < warmBitrate);
  }

  @Test
  public void highEightiesKeepsAtLeastOneMbpsOnTwoMbpsRequest() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(2_000_000);
    StreamingBitrateTemperatureController.BitrateDecision decision =
        controller.update(87_000, 2_000_000);

    Assert.assertTrue(decision.getTargetBitrateBps() >= 1_000_000);
  }

  @Test
  public void emergencyStartsAtNinetyC() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(4_000_000);
    StreamingBitrateTemperatureController.BitrateDecision decision =
        controller.update(90_000, 4_000_000);

    Assert.assertTrue(decision.isHardLimitActive());
    Assert.assertTrue(decision.getTargetBitrateBps() <= 800_000);
  }

  @Test
  public void controllerUsesRequestedBitrateAsItsBaseline() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(1_000_000);
    int lowerTarget = controller.update(88_000, 1_000_000).getTargetBitrateBps();

    controller.reset(3_000_000);
    int higherTarget = controller.update(88_000, 3_000_000).getTargetBitrateBps();

    Assert.assertTrue(higherTarget > lowerTarget);
    Assert.assertTrue(lowerTarget <= 1_000_000);
    Assert.assertTrue(higherTarget <= 3_000_000);
  }

  @Test
  public void hardLimitAboveNinetyCTriggersAggressiveReduction() {
    StreamingBitrateTemperatureController controller =
        new StreamingBitrateTemperatureController();

    controller.reset(4_000_000);
    StreamingBitrateTemperatureController.BitrateDecision decision =
        controller.update(90_300, 4_000_000);

    Assert.assertTrue(decision.isHardLimitActive());
    Assert.assertTrue(decision.getTargetBitrateBps() <= 300_000);
  }

  @Test
  public void smoothingStillDampensTemperatureSpikes() {
    int smoothed = StreamingThermalUtils.smoothCpuTemperature(89_000, 90_400);

    Assert.assertTrue(smoothed > 89_000);
    Assert.assertTrue(smoothed < 90_400);
  }
}
