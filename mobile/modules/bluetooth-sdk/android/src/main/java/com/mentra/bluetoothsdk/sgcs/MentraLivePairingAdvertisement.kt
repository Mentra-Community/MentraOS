package com.mentra.bluetoothsdk.sgcs

internal data class MentraLivePairingAdvertisement(
    val pairingMode: Boolean,
    val pairingCode: String,
)

internal object MentraLivePairingAdvertisementParser {
    private const val PAIRING_FLAG_OFFSET = 5
    private const val PAIRING_DISCOVERABLE: Byte = 0x01
    private const val PROTOCOL_VERSION_OFFSET = PAIRING_FLAG_OFFSET + 1
    private const val CAPABILITY_OFFSET = PROTOCOL_VERSION_OFFSET + 1
    private const val CODE_LOW_OFFSET = CAPABILITY_OFFSET + 1
    private const val CODE_HIGH_OFFSET = CODE_LOW_OFFSET + 1
    private const val MAGIC_FIRST_OFFSET = CODE_HIGH_OFFSET + 1
    private const val MAGIC_SECOND_OFFSET = MAGIC_FIRST_OFFSET + 1
    private const val PROTOCOL_VERSION_MIN = 2
    private const val PROTOCOL_VERSION_MAX = 15
    private const val SECURE_PAIRING_CAPABILITY = 0x01
    private const val MAGIC_FIRST = 0x4D // M
    private const val MAGIC_SECOND = 0x50 // P

    /**
     * Parses company-id-stripped 0xB822 manufacturer data.
     *
     * Legacy firmware stores an XOR'd Classic MAC where the original pairing implementation
     * expected version and capability bytes. Requiring the `MP` marker makes the formats
     * unambiguous instead of probabilistically classifying MAC bytes as a secure trailer.
     */
    fun parse(manufacturerData: ByteArray?): MentraLivePairingAdvertisement? {
        if (manufacturerData == null || manufacturerData.size <= MAGIC_SECOND_OFFSET) {
            return null
        }

        val version = manufacturerData[PROTOCOL_VERSION_OFFSET].toInt() and 0xFF
        val capability = manufacturerData[CAPABILITY_OFFSET].toInt() and 0xFF
        val magicFirst = manufacturerData[MAGIC_FIRST_OFFSET].toInt() and 0xFF
        val magicSecond = manufacturerData[MAGIC_SECOND_OFFSET].toInt() and 0xFF
        if (version !in PROTOCOL_VERSION_MIN..PROTOCOL_VERSION_MAX ||
            (capability and SECURE_PAIRING_CAPABILITY) == 0 ||
            magicFirst != MAGIC_FIRST ||
            magicSecond != MAGIC_SECOND
        ) {
            return null
        }

        val codeLow = manufacturerData[CODE_LOW_OFFSET].toInt() and 0xFF
        val codeHigh = manufacturerData[CODE_HIGH_OFFSET].toInt() and 0xFF
        return MentraLivePairingAdvertisement(
            pairingMode = manufacturerData[PAIRING_FLAG_OFFSET] == PAIRING_DISCOVERABLE,
            pairingCode = String.format("%02X%02X", codeHigh, codeLow),
        )
    }
}
