package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import org.junit.Test;
import org.mockito.Mockito;

/** Verifies {@link BesOtaRegistry} behavior through the core {@link IBesOtaRegistry} interface. */
public class BesOtaRegistryTest {

    @Test
    public void getInstance_initiallyNull() {
        IBesOtaRegistry registry = new BesOtaRegistry();

        assertThat(registry.getInstance()).isNull();
    }

    @Test
    public void setInstance_thenGetInstance_returnsSameController() {
        IBesOtaRegistry registry = new BesOtaRegistry();
        IBesOtaController controller = Mockito.mock(IBesOtaController.class);

        registry.setInstance(controller);

        assertThat(registry.getInstance()).isSameAs(controller);
    }

    @Test
    public void clear_removesController() {
        IBesOtaRegistry registry = new BesOtaRegistry();
        registry.setInstance(Mockito.mock(IBesOtaController.class));

        registry.clear();

        assertThat(registry.getInstance()).isNull();
    }
}
