package com.mentra.asg_client.io.peripheral;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies subscribe/unsubscribe/publish semantics of {@link SimplePeripheralBus}. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class SimplePeripheralBusTest {

    @Test
    public void publish_deliversToSubscriber() {
        SimplePeripheralBus bus = new SimplePeripheralBus();
        List<McuEvent> received = new ArrayList<>();
        bus.subscribe(received::add);

        McuEvent event = new ShutdownEvent();
        bus.publish(event);

        assertThat(received).containsExactly(event);
    }

    @Test
    public void unsubscribe_stopsDelivery() {
        SimplePeripheralBus bus = new SimplePeripheralBus();
        List<McuEvent> received = new ArrayList<>();
        IPeripheralBus.McuEventListener listener = received::add;

        bus.subscribe(listener);
        bus.unsubscribe(listener);
        bus.publish(new ShutdownEvent());

        assertThat(received).isEmpty();
    }

    @Test
    public void publish_deliversToAllSubscribers() {
        SimplePeripheralBus bus = new SimplePeripheralBus();
        List<McuEvent> first = new ArrayList<>();
        List<McuEvent> second = new ArrayList<>();
        bus.subscribe(first::add);
        bus.subscribe(second::add);

        McuEvent event = new ShutdownEvent();
        bus.publish(event);

        assertThat(first).containsExactly(event);
        assertThat(second).containsExactly(event);
    }

    @Test
    public void throwingSubscriber_doesNotBlockOthers() {
        SimplePeripheralBus bus = new SimplePeripheralBus();
        List<McuEvent> received = new ArrayList<>();
        bus.subscribe(
                e -> {
                    throw new RuntimeException("boom");
                });
        bus.subscribe(received::add);

        McuEvent event = new ShutdownEvent();
        bus.publish(event);

        assertThat(received).containsExactly(event);
    }

    @Test
    public void subscribeSameListenerTwice_deliversOnce() {
        SimplePeripheralBus bus = new SimplePeripheralBus();
        List<McuEvent> received = new ArrayList<>();
        IPeripheralBus.McuEventListener listener = received::add;
        bus.subscribe(listener);
        bus.subscribe(listener);

        bus.publish(new ShutdownEvent());

        assertThat(received).hasSize(1);
    }
}
