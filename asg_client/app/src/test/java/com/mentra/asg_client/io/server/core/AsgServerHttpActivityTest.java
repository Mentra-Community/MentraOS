package com.mentra.asg_client.io.server.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.server.interfaces.CacheManager;
import com.mentra.asg_client.io.server.interfaces.NetworkProvider;
import com.mentra.asg_client.io.server.interfaces.RateLimiter;
import com.mentra.asg_client.io.server.interfaces.ServerConfig;
import com.mentra.asg_client.logging.Logger;
import fi.iki.elonen.NanoHTTPD;
import java.io.ByteArrayInputStream;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
public class AsgServerHttpActivityTest {
    @Test
    public void requestAndLongResponseStreamNotifyHttpActivityListener() throws Exception {
        ServerConfig config = mock(ServerConfig.class);
        NetworkProvider networkProvider = mock(NetworkProvider.class);
        CacheManager cacheManager = mock(CacheManager.class);
        RateLimiter rateLimiter = mock(RateLimiter.class);
        Logger logger = mock(Logger.class);
        when(config.getPort()).thenReturn(8089);
        when(rateLimiter.isAllowed("phone")).thenReturn(true);

        TestServer server = new TestServer(config, networkProvider, cacheManager, rateLimiter, logger);
        AtomicInteger activityCount = new AtomicInteger();
        server.setHttpActivityListener(activityCount::incrementAndGet);

        NanoHTTPD.IHTTPSession session = mock(NanoHTTPD.IHTTPSession.class);
        when(session.getUri()).thenReturn("/api/health");
        when(session.getMethod()).thenReturn(NanoHTTPD.Method.GET);
        when(session.getRemoteIpAddress()).thenReturn("phone");
        when(session.getHeaders()).thenReturn(java.util.Collections.emptyMap());

        NanoHTTPD.Response response = server.serve(session);

        assertThat(response.getData()).isNotNull();
        assertThat(activityCount.get()).isEqualTo(1);

        ShadowSystemClock.advanceBy(Duration.ofSeconds(6));
        assertThat(response.getData().read(new byte[3])).isEqualTo(3);
        assertThat(activityCount.get()).isEqualTo(2);
    }

    @Test
    public void bindAddressRestrictsServerAndDeterminesAdvertisedUrl() {
        ServerConfig config = mock(ServerConfig.class);
        NetworkProvider networkProvider = mock(NetworkProvider.class);
        CacheManager cacheManager = mock(CacheManager.class);
        RateLimiter rateLimiter = mock(RateLimiter.class);
        Logger logger = mock(Logger.class);
        when(config.getPort()).thenReturn(0);
        when(networkProvider.getBestIpAddress()).thenReturn("10.0.0.25");

        TestServer server =
                new TestServer(
                        config,
                        networkProvider,
                        cacheManager,
                        rateLimiter,
                        logger,
                        "127.0.0.1");

        server.startServer();
        try {
            assertThat(server.isAlive()).isTrue();
            assertThat(server.getHostname()).isEqualTo("127.0.0.1");
            assertThat(server.getServerUrl())
                    .isEqualTo("http://127.0.0.1:" + server.getListeningPort());
        } finally {
            server.stopServer();
        }
    }

    private static final class TestServer extends AsgServer {
        TestServer(
                ServerConfig config,
                NetworkProvider networkProvider,
                CacheManager cacheManager,
                RateLimiter rateLimiter,
                Logger logger) {
            super(config, networkProvider, cacheManager, rateLimiter, logger);
        }

        TestServer(
                ServerConfig config,
                NetworkProvider networkProvider,
                CacheManager cacheManager,
                RateLimiter rateLimiter,
                Logger logger,
                String bindAddress) {
            super(config, networkProvider, cacheManager, rateLimiter, logger, bindAddress);
        }

        @Override
        protected String getTag() {
            return "TestServer";
        }

        @Override
        protected Response handleRequest(IHTTPSession session) {
            return newFixedLengthResponse(
                    Response.Status.OK,
                    "application/octet-stream",
                    new ByteArrayInputStream(new byte[] {1, 2, 3}),
                    3);
        }
    }
}
