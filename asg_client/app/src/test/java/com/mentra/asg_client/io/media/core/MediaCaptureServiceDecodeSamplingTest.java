package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class MediaCaptureServiceDecodeSamplingTest {

  @Test
  public void subsamplesLandscapeSensorFrameToSquareCap() {
    assertThat(MediaCaptureService.computeBleDecodeSampleSize(4032, 3024, 1920, 1920))
        .isEqualTo(2);
  }

  @Test
  public void subsamplesPortraitSensorFrameToSquareCap() {
    assertThat(MediaCaptureService.computeBleDecodeSampleSize(3024, 4032, 1920, 1920))
        .isEqualTo(2);
  }

  @Test
  public void usesAspectFittedOutputRatherThanFullTargetBox() {
    assertThat(MediaCaptureService.computeBleDecodeSampleSize(4000, 1000, 1920, 1920))
        .isEqualTo(2);
  }

  @Test
  public void doesNotSubsampleRegionSmallerThanTargetCap() {
    assertThat(MediaCaptureService.computeBleDecodeSampleSize(824, 1216, 1920, 1920))
        .isEqualTo(1);
  }
}
