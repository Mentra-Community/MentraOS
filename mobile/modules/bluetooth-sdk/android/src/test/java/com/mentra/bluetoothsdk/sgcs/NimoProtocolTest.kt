package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class NimoCrc16Test {

    @Test
    fun `matches CRC-16-CCITT-FALSE check value`() {
        // The standard check input "123456789" → 0x29B1 for CRC-16/CCITT-FALSE.
        val data = "123456789".toByteArray(Charsets.US_ASCII)
        assertThat(nimoCrc16(data)).isEqualTo(0x29B1)
    }

    @Test
    fun `empty input yields init value`() {
        assertThat(nimoCrc16(ByteArray(0))).isEqualTo(0xFFFF)
    }
}

class NimoFrameCodecTest {

    @Test
    fun `transport header layout`() {
        val payload = byteArrayOf(0x03, 0x01, 0x01, 0x00, 0x42)
        val header = NimoFrameCodec.transportHeader(payload, index = 0x0201, needsAck = true)
        assertThat(header).hasSize(8)
        assertThat(header[0].toInt() and 0xFF).isEqualTo(0xBF)
        assertThat(header[1].toInt() and 0xFF).isEqualTo(0x02) // ack bit
        assertThat(header[2].toInt() and 0xFF).isEqualTo(payload.size) // len LE
        assertThat(header[3].toInt() and 0xFF).isEqualTo(0)
        val crc = nimoCrc16(payload)
        assertThat(header[4].toInt() and 0xFF).isEqualTo(crc and 0xFF)
        assertThat(header[5].toInt() and 0xFF).isEqualTo((crc shr 8) and 0xFF)
        assertThat(header[6].toInt() and 0xFF).isEqualTo(0x01) // index LE
        assertThat(header[7].toInt() and 0xFF).isEqualTo(0x02)
    }

    @Test
    fun `request frame layout`() {
        // setBrightness level 8: cmd=0x03 key=0x02 payload=[0x08]
        val frame = NimoFrameCodec.encodeFrame(0x03, 0x02, byteArrayOf(0x08))
        assertThat(frame).hasSize(8 + 4 + 1)
        // app header after transport header
        assertThat(frame[8].toInt()).isEqualTo(0x03)
        assertThat(frame[9].toInt()).isEqualTo(0x02)
        assertThat(frame[10].toInt()).isEqualTo(0x01) // payload len LE
        assertThat(frame[11].toInt()).isEqualTo(0x00)
        assertThat(frame[12].toInt()).isEqualTo(0x08)
    }

    @Test
    fun `decode parses a response frame and validates crc`() {
        // Response layout: [cmd][key][len(2)][status][data]
        val appPayload = byteArrayOf(0x02, 0x06, 0x04, 0x00, 0x00, 90, 85, 0, 1)
        val frame = NimoFrameCodec.transportHeader(appPayload, index = 0) + appPayload
        val decoded = NimoFrameCodec.decode(frame)
        assertThat(decoded).isNotNull
        assertThat(decoded!!.cmd).isEqualTo(0x02)
        assertThat(decoded.key).isEqualTo(0x06)
        assertThat(decoded.statusCode).isEqualTo(0)
        assertThat(decoded.data).containsExactly(90, 85, 0, 1)
    }

    @Test
    fun `decode rejects corrupt crc`() {
        val appPayload = byteArrayOf(0x02, 0x06, 0x04, 0x00, 0x00, 90, 85, 0, 1)
        val frame = NimoFrameCodec.transportHeader(appPayload) + appPayload
        frame[10] = (frame[10] + 1).toByte() // corrupt a payload byte after CRC was computed
        assertThat(NimoFrameCodec.decode(frame)).isNull()
    }

    @Test
    fun `decode rejects wrong magic and error status`() {
        val appPayload = byteArrayOf(0x02, 0x06, 0x00, 0x00, 0x00)
        val good = NimoFrameCodec.transportHeader(appPayload) + appPayload
        val badMagic = good.copyOf().also { it[0] = 0x00 }
        assertThat(NimoFrameCodec.decode(badMagic)).isNull()
        val errStatus = good.copyOf().also { it[1] = 0x01 } // err bit set
        assertThat(NimoFrameCodec.decode(errStatus)).isNull()
    }

    @Test
    fun `single chunk content update has index zero`() {
        val frames = NimoFrameCodec.updateContentFrames(0x06, 0, 0, 0x00, "hello".toByteArray())
        assertThat(frames).hasSize(1)
        val frame = frames[0]
        // index bytes
        assertThat(frame[6].toInt()).isEqualTo(0)
        assertThat(frame[7].toInt()).isEqualTo(0)
        // app header: cmd=0x07 key=0x04 len = 4 + 5
        assertThat(frame[8].toInt()).isEqualTo(0x07)
        assertThat(frame[9].toInt()).isEqualTo(0x04)
        assertThat(frame[10].toInt()).isEqualTo(9)
        // resource prefix [appId][layoutId][resId][resType]
        assertThat(frame[12].toInt()).isEqualTo(0x06)
        assertThat(frame[13].toInt()).isEqualTo(0x00)
        assertThat(frame[14].toInt()).isEqualTo(0x00)
        assertThat(frame[15].toInt()).isEqualTo(0x00)
        assertThat(String(frame.copyOfRange(16, 21))).isEqualTo("hello")
    }

    @Test
    fun `multi chunk content update follows the index rule`() {
        // Full app data = 4 (header) + 4 (prefix) + content. Pick content so we get 3 chunks:
        // total = 8 + 1200 = 1208 → chunks of 501, 501, 206.
        val content = ByteArray(1200) { (it % 251).toByte() }
        val frames = NimoFrameCodec.updateContentFrames(0x06, 0, 0, 0x00, content)
        assertThat(frames).hasSize(3)
        // indices: 1, 2, 0 (last)
        assertThat(frames[0][6].toInt()).isEqualTo(1)
        assertThat(frames[1][6].toInt()).isEqualTo(2)
        assertThat(frames[2][6].toInt()).isEqualTo(0)
        // chunk sizes via the transport length field
        fun len(f: ByteArray) = (f[2].toInt() and 0xFF) or ((f[3].toInt() and 0xFF) shl 8)
        assertThat(len(frames[0])).isEqualTo(501)
        assertThat(len(frames[1])).isEqualTo(501)
        assertThat(len(frames[2])).isEqualTo(206)
        // every chunk's CRC covers that chunk only
        for (f in frames) {
            val payload = f.copyOfRange(8, 8 + len(f))
            val crc = (f[4].toInt() and 0xFF) or ((f[5].toInt() and 0xFF) shl 8)
            assertThat(nimoCrc16(payload)).isEqualTo(crc)
        }
        // chunks concatenate back to the full app data
        val merged = frames.flatMap { f -> f.copyOfRange(8, 8 + len(f)).toList() }.toByteArray()
        assertThat(merged).hasSize(1208)
        assertThat(merged[0].toInt()).isEqualTo(0x07)
        assertThat(merged.copyOfRange(8, 1208)).isEqualTo(content)
    }

    @Test
    fun `image header layout`() {
        val header =
                NimoFrameCodec.imageHeader(
                        width = 304,
                        height = 180,
                        formatBpp = 0x02,
                        compression = 0x07,
                        originalSize = 13680,
                        compressedSize = 4096
                )
        assertThat(header).hasSize(15)
        assertThat(header[0].toInt() and 0xFF).isEqualTo(0x16)
        assertThat((header[1].toInt() and 0xFF) or ((header[2].toInt() and 0xFF) shl 8)).isEqualTo(304)
        assertThat((header[3].toInt() and 0xFF) or ((header[4].toInt() and 0xFF) shl 8)).isEqualTo(180)
        assertThat(header[5].toInt()).isEqualTo(0x02)
        assertThat(header[6].toInt()).isEqualTo(0x07)
        val originalSize =
                (header[7].toInt() and 0xFF) or
                        ((header[8].toInt() and 0xFF) shl 8) or
                        ((header[9].toInt() and 0xFF) shl 16) or
                        ((header[10].toInt() and 0xFF) shl 24)
        assertThat(originalSize).isEqualTo(13680)
    }

    @Test
    fun `device time is nine bytes with sane fields`() {
        // 2026-06-11 is a Thursday (week=4 with Sunday=0).
        val cal = java.util.Calendar.getInstance()
        cal.set(2026, java.util.Calendar.JUNE, 11, 15, 30, 45)
        val b = NimoFrameCodec.encodeDeviceTime(cal.timeInMillis)
        assertThat(b).hasSize(9)
        assertThat((b[0].toInt() and 0xFF) or ((b[1].toInt() and 0xFF) shl 8)).isEqualTo(2026)
        assertThat(b[2].toInt()).isEqualTo(6)
        assertThat(b[3].toInt()).isEqualTo(11)
        assertThat(b[4].toInt()).isEqualTo(15)
        assertThat(b[5].toInt()).isEqualTo(30)
        assertThat(b[6].toInt()).isEqualTo(45)
        assertThat(b[7].toInt()).isEqualTo(4)
        // zone is the local offset in 15-minute units, clamped to ±48
        val zone = b[8].toInt().toByte().toInt()
        assertThat(zone).isBetween(-48, 48)
    }
}

class NimoReceiveAssemblerTest {

    /** Builds one response fragment: transport header(index) + [cmd][key][len][status][data]. */
    private fun fragment(cmd: Int, key: Int, status: Int, data: ByteArray, index: Int): ByteArray {
        val appPayload =
                byteArrayOf(
                        cmd.toByte(),
                        key.toByte(),
                        (data.size and 0xFF).toByte(),
                        ((data.size shr 8) and 0xFF).toByte(),
                        status.toByte()
                ) + data
        return NimoFrameCodec.transportHeader(appPayload, index = index) + appPayload
    }

    @Test
    fun `single packet passes through unchanged`() {
        val assembler = NimoReceiveAssembler()
        val frame = fragment(0x02, 0x06, 0x00, byteArrayOf(90, 85, 0, 1), index = 0)
        val out = assembler.ingest(frame)
        assertThat(out).hasSize(1)
        assertThat(out[0]).isEqualTo(frame)
    }

    @Test
    fun `fragments merge in index order and reframe decodes`() {
        val assembler = NimoReceiveAssembler()
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "ver".toByteArray(), index = 1))).isEmpty()
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "sion-".toByteArray(), index = 2))).isEmpty()
        val out = assembler.ingest(fragment(0x02, 0x0B, 0x00, "1.2.3".toByteArray(), index = 0))
        assertThat(out).hasSize(1)
        val decoded = NimoFrameCodec.decode(out[0])
        assertThat(decoded).isNotNull
        assertThat(decoded!!.cmd).isEqualTo(0x02)
        assertThat(decoded.key).isEqualTo(0x0B)
        assertThat(decoded.statusCode).isEqualTo(0)
        assertThat(String(decoded.data!!)).isEqualTo("version-1.2.3")
    }

    @Test
    fun `out of order middle fragment is tolerated`() {
        val assembler = NimoReceiveAssembler()
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "B".toByteArray(), index = 2))).isEmpty()
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "A".toByteArray(), index = 1))).isEmpty()
        val out = assembler.ingest(fragment(0x02, 0x0B, 0x00, "C".toByteArray(), index = 0))
        assertThat(out).hasSize(1)
        val decoded = NimoFrameCodec.decode(out[0])
        assertThat(String(decoded!!.data!!)).isEqualTo("ABC")
    }

    @Test
    fun `stale first fragment is dropped when a new round starts`() {
        val assembler = NimoReceiveAssembler()
        // Round 1 loses its last packet.
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "stale".toByteArray(), index = 1))).isEmpty()
        // Round 2 starts fresh.
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "fresh".toByteArray(), index = 1))).isEmpty()
        val out = assembler.ingest(fragment(0x02, 0x0B, 0x00, "!".toByteArray(), index = 0))
        val decoded = NimoFrameCodec.decode(out[0])
        assertThat(String(decoded!!.data!!)).isEqualTo("fresh!")
    }

    @Test
    fun `different cmd-key groups do not cross-merge`() {
        val assembler = NimoReceiveAssembler()
        assertThat(assembler.ingest(fragment(0x02, 0x0B, 0x00, "v".toByteArray(), index = 1))).isEmpty()
        // A complete single frame from another (cmd,key) passes through while the group is open.
        val battery = fragment(0x02, 0x06, 0x00, byteArrayOf(90, 85, 0, 1), index = 0)
        assertThat(assembler.ingest(battery)).containsExactly(battery)
        val out = assembler.ingest(fragment(0x02, 0x0B, 0x00, "1".toByteArray(), index = 0))
        assertThat(String(NimoFrameCodec.decode(out[0])!!.data!!)).isEqualTo("v1")
    }
}

class NimoAudioParserTest {

    private fun audioPacket(type: Int, sn: Int, frames: List<ByteArray>): ByteArray {
        val payload = ByteArrayPacker()
        payload.add((sn and 0xFF).toByte(), ((sn shr 8) and 0xFF).toByte())
        payload.add(frames.size.toByte(), 0x00)
        for (opus in frames) {
            val body = ByteArray(8 + opus.size)
            body[3] = opus.size.toByte() // opusLen at body[3]
            opus.copyInto(body, 8)
            payload.add((body.size).toByte())
            payload.addAll(body)
        }
        val p = payload.toByteArray()
        return byteArrayOf(0x52, type.toByte(), (p.size and 0xFF).toByte(), ((p.size shr 8) and 0xFF).toByte()) + p
    }

    private class ByteArrayPacker {
        private val out = java.io.ByteArrayOutputStream()
        fun add(vararg bytes: Byte) = out.write(bytes)
        fun addAll(bytes: ByteArray) = out.write(bytes)
        fun toByteArray(): ByteArray = out.toByteArray()
    }

    @Test
    fun `parses right-ear opus frames sliced by opusLen`() {
        val opus1 = byteArrayOf(0xAA.toByte(), 0xBB.toByte(), 0xCC.toByte())
        val opus2 = byteArrayOf(0x01, 0x02)
        val packet = audioPacket(NimoAudioParser.TYPE_OPUS_RIGHT, 0x1234, listOf(opus1, opus2))
        val parsed = NimoAudioParser.parse(packet)
        assertThat(parsed).isNotNull
        assertThat(parsed!!.type).isEqualTo(NimoAudioParser.TYPE_OPUS_RIGHT)
        assertThat(parsed.sequence).isEqualTo(0x1234)
        assertThat(parsed.opusFrames).hasSize(2)
        assertThat(parsed.opusFrames[0]).isEqualTo(opus1)
        assertThat(parsed.opusFrames[1]).isEqualTo(opus2)
    }

    @Test
    fun `start and stop packets carry no frames`() {
        assertThat(NimoAudioParser.parse(byteArrayOf(0x52, 0x01, 0x00, 0x00))!!.type)
                .isEqualTo(NimoAudioParser.TYPE_START)
        assertThat(NimoAudioParser.parse(byteArrayOf(0x52, 0x00, 0x00, 0x00))!!.type)
                .isEqualTo(NimoAudioParser.TYPE_STOP)
    }

    @Test
    fun `rejects wrong header and short input`() {
        assertThat(NimoAudioParser.parse(byteArrayOf(0x51, 0x02, 0x00, 0x00))).isNull()
        assertThat(NimoAudioParser.parse(byteArrayOf(0x52, 0x02))).isNull()
    }

    @Test
    fun `skips frames with short header or opus overrun`() {
        // frame 1: frameLen=4 (<8) → skipped; frame 2: opusLen overruns frameLen → skipped;
        // frame 3: valid.
        val valid = byteArrayOf(0x0F)
        val payload = ByteArrayPacker()
        payload.add(0x01, 0x00) // SN
        payload.add(0x03, 0x00) // frameCnt=3
        // frame 1: short header
        payload.add(0x04)
        payload.addAll(ByteArray(4))
        // frame 2: opusLen 20 > frameLen-8
        val bad = ByteArray(10)
        bad[3] = 20
        payload.add(0x0A)
        payload.addAll(bad)
        // frame 3: valid 1-byte opus
        val body = ByteArray(9)
        body[3] = 1
        body[8] = valid[0]
        payload.add(0x09)
        payload.addAll(body)
        val p = payload.toByteArray()
        val packet =
                byteArrayOf(0x52, 0x02, (p.size and 0xFF).toByte(), ((p.size shr 8) and 0xFF).toByte()) + p

        val parsed = NimoAudioParser.parse(packet)
        assertThat(parsed!!.opusFrames).hasSize(1)
        assertThat(parsed.opusFrames[0]).isEqualTo(valid)
    }
}
