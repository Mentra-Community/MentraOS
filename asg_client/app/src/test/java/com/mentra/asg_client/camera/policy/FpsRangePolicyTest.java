package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import android.util.Range;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 3 prep unit tests for {@link FpsRangePolicy}. The selection priorities must match the
 * inline heuristic that previously lived in {@code CameraNeoService.chooseOptimalFpsRange}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FpsRangePolicyTest {

    @SafeVarargs
    private static Range<Integer>[] ranges(Range<Integer>... rs) {
        return rs;
    }

    @Test
    public void prefersWideRangeThatIncludes30AndStartsAt5OrBelow() {
        Range<Integer>[] options = ranges(
                Range.create(15, 30),
                Range.create(5, 30),
                Range.create(30, 30));
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(5, 30));
    }

    @Test
    public void wideRange_pickedEvenIfNotFirst() {
        Range<Integer>[] options = ranges(
                Range.create(30, 30),
                Range.create(15, 30),
                Range.create(3, 30));
        // 3-30 has lower <= 5 and contains 30 → wins step 1.
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(3, 30));
    }

    @Test
    public void falconBackToModerateRange_includes30AndLowerLeq15() {
        Range<Integer>[] options = ranges(
                Range.create(30, 30),
                Range.create(15, 30));
        // 30-30 starts at 30 (not <= 5); 15-30 has lower <= 15 → wins step 2.
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(15, 30));
    }

    @Test
    public void firstStepBeatsSecondStep_whenBothAvailable() {
        Range<Integer>[] options = ranges(
                Range.create(15, 30), // step 2 candidate
                Range.create(5, 30)); // step 1 candidate
        // Step 1 always wins over step 2.
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(5, 30));
    }

    @Test
    public void finalFallback_picksRangeWithHighestMinFps() {
        Range<Integer>[] options = ranges(
                Range.create(60, 60),
                Range.create(90, 120),
                Range.create(120, 240));
        // None contains 30, so step 1 + step 2 both miss → final fallback picks highest min.
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(120, 240));
    }

    @Test
    public void finalFallback_whenOnlyOneRange_returnsThatRange() {
        Range<Integer>[] options = ranges(Range.create(60, 60));
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(60, 60));
    }

    @SuppressWarnings("unchecked")
    @Test
    public void emptyArray_throws() {
        Range<Integer>[] empty = (Range<Integer>[]) new Range[0];
        assertThatThrownBy(() -> FpsRangePolicy.chooseOptimalFpsRange(empty))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    public void nullArray_throws() {
        assertThatThrownBy(() -> FpsRangePolicy.chooseOptimalFpsRange(null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    public void defaultFpsRangeIs30Fixed() {
        // Sanity check for the fallback constant CameraNeoService uses when no characteristic is published.
        assertThat(FpsRangePolicy.DEFAULT_FPS_RANGE).isEqualTo(Range.create(30, 30));
    }

    @Test
    public void rangeNotContaining30_isIgnoredInStep1And2() {
        Range<Integer>[] options = ranges(
                Range.create(3, 24), // wide but doesn't contain 30
                Range.create(60, 90)); // doesn't contain 30
        // Both step 1 and step 2 miss → fallback picks highest min (60).
        assertThat(FpsRangePolicy.chooseOptimalFpsRange(options))
                .isEqualTo(Range.create(60, 90));
    }
}
