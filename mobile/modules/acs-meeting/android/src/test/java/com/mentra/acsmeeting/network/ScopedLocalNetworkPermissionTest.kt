package com.mentra.acsmeeting.network

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ScopedLocalNetworkPermissionTest {
    @Test
    fun `Android 17 preserves implicit access for the SDK 36 host`() {
        assertThat(ScopedSoftApNetwork.hasLocalNetworkPermission(37, 36) {
            error("Legacy targets must not query the unneeded runtime grant")
        }).isTrue()
    }

    @Test
    fun `older Android does not query a permission it cannot enforce`() {
        assertThat(ScopedSoftApNetwork.hasLocalNetworkPermission(36, 37) {
            error("Older Android must not query the new permission")
        }).isTrue()
    }

    @Test
    fun `Android 17 denies a target 37 host without the grant`() {
        assertThat(ScopedSoftApNetwork.hasLocalNetworkPermission(37, 37) { false }).isFalse()
    }

    @Test
    fun `Android 17 allows a target 37 host with the grant`() {
        assertThat(ScopedSoftApNetwork.hasLocalNetworkPermission(37, 37) { true }).isTrue()
    }

    @Test
    fun `future Android and target versions still enforce the grant`() {
        assertThat(ScopedSoftApNetwork.hasLocalNetworkPermission(38, 38) { false }).isFalse()
    }
}
