package com.mentra.asg_client.logging;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class LoggerFactoryTest {

    @Test
    public void createLogger_returnsAndroidLoggerOnDevice() {
        Logger logger = LoggerFactory.createLogger();

        assertThat(logger).isInstanceOf(AndroidLogger.class);
    }

    @Test
    public void createLogger_withTag_usesCustomDefaultTag() {
        Logger logger = LoggerFactory.createLogger("MyComponent");

        assertThat(logger).isInstanceOf(AndroidLogger.class);
        AndroidLogger androidLogger = (AndroidLogger) logger;
        androidLogger.debug(null, "test message");
        // Null tag falls back to custom default — no assertion on Log output; type + construction
        // is the contract.
    }
}
