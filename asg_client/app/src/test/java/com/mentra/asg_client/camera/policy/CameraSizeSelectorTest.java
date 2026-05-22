package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.util.Size;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraSizeSelectorTest {

    @Test
    public void chooseOptimalSize_returnsExactMatch() {
        Size exact = new Size(1280, 960);

        Size chosen = CameraSizeSelector.chooseOptimalSize(
                new Size[] {new Size(640, 480), exact}, 1280, 960);

        assertThat(chosen).isSameAs(exact);
    }

    @Test
    public void chooseOptimalSize_returnsClosestByDimensionDelta() {
        Size closest = new Size(1280, 960);

        Size chosen = CameraSizeSelector.chooseOptimalSize(
                new Size[] {new Size(3264, 2448), closest, new Size(640, 480)}, 1440, 1088);

        assertThat(chosen).isSameAs(closest);
    }

    @Test
    public void chooseOptimalSize_withNoChoices_returnsNull() {
        assertThat(CameraSizeSelector.chooseOptimalSize(new Size[0], 1440, 1088)).isNull();
        assertThat(CameraSizeSelector.chooseOptimalSize(null, 1440, 1088)).isNull();
    }
}
