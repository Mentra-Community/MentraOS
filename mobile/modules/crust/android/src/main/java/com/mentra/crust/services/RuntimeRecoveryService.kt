package com.mentra.crust.services

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Boots the normal app runtime while the Bluetooth foreground service keeps it alive. */
class RuntimeRecoveryService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig("MentraRuntimeRecovery", Arguments.createMap(), 120_000L, true)
}
