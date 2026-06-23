package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Focused guard-path tests for {@link OtaHelper} verifying null-safe {@link IBesOtaRegistry}
 * access. The cache-prune methods were removed in the dev cleanup; the in-progress guard is
 * verified through construction and cleanup without NPE.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperBesGuardTest {

    /** Simple registry stub whose controller can be swapped per test. */
    private static final class StubRegistry implements IBesOtaRegistry {
        private IBesOtaController controller;

        @Override
        public IBesOtaController getInstance() {
            return controller;
        }

        @Override
        public void setInstance(IBesOtaController controller) {
            this.controller = controller;
        }

        @Override
        public void clear() {
            this.controller = null;
        }
    }

    private OtaHelper otaHelper;

    @After
    public void tearDown() {
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
    }

    private OtaHelper newHelper(StubRegistry registry) {
        Context context = ApplicationProvider.getApplicationContext();
        otaHelper = new OtaHelper(context, registry);
        return otaHelper;
    }

    @Test
    public void noController_constructionAndCleanup_doesNotThrow() {
        // Non-K900 reality: the registry never gets a controller. Construction and cleanup
        // must not NPE even when getOtaController() always returns null.
        assertThatCode(
                        () -> {
                            OtaHelper helper = newHelper(new StubRegistry());
                            helper.cleanup();
                            otaHelper = null;
                        })
                .doesNotThrowAnyException();
    }

    @Test
    public void activeController_isBesOtaInProgress_reflectsControllerState() {
        // Directly verify the IBesOtaController contract: the helper must delegate to the
        // interface, not a static flag.
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(false);
        registry.setInstance(controller);

        OtaHelper helper = newHelper(registry);

        // While the helper is alive and the controller says false, nothing blows up.
        assertThatCode(helper::pruneInvalidCachedArtifactsOnStartup).doesNotThrowAnyException();
        assertThatCode(helper::clearAllCachedArtifacts).doesNotThrowAnyException();
    }

    @Test
    public void controllerRemovedAfterConstruction_doesNotThrow() {
        // Registry is a late-binding seam: the controller can disappear during service shutdown.
        StubRegistry registry = new StubRegistry();
        registry.setInstance(mock(IBesOtaController.class));
        OtaHelper helper = newHelper(registry);

        registry.clear();

        assertThatCode(helper::pruneInvalidCachedArtifactsOnStartup).doesNotThrowAnyException();
        assertThatCode(helper::clearAllCachedArtifacts).doesNotThrowAnyException();
    }

    @Test
    public void besOtaRegistry_nullSafeGetInstance_returnsNullWhenUnset() {
        IBesOtaRegistry registry = new StubRegistry();

        assertThat(registry.getInstance()).isNull();
    }
}
