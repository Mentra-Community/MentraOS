package com.mentra.bluetoothsdk

internal fun incomingGlassesMessageAckId(type: String, messageId: Long?): Long? =
    messageId?.takeIf { type != "msg_ack" }
