package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class G1TextSanitizerTest {

    @Test
    fun `strips Vietnamese diacritics unsupported by G1`() {
        assertThat(sanitizeG1DisplayText("Tiếng Việt: Đặng, Nguyễn, phở bò"))
            .isEqualTo("Tieng Viet: Dang, Nguyen, pho bò")
    }

    @Test
    fun `handles decomposed marks and preserves layout`() {
        assertThat(sanitizeG1DisplayText("Cafe\u0301\nĐa Nang"))
            .isEqualTo("Café\nDa Nang")
    }

    @Test
    fun `preserves mapped letters and expands only unmapped letters`() {
        assertThat(sanitizeG1DisplayText("Øresund Łódź Æsir Œuvre Straße Ðingvellir Þingvellir"))
            .isEqualTo("Øresund Łódź Æsir OEuvre Straße Ðingvellir Þingvellir")
    }

    @Test
    fun `leaves text without diacritics unchanged`() {
        assertThat(sanitizeG1DisplayText("Hello, world! 123"))
            .isEqualTo("Hello, world! 123")
    }

    @Test
    fun `preserves Swedish accents case punctuation and spacing`() {
        assertThat(sanitizeG1DisplayText("“Hallå, hallå”\nÅÄÖ åäö"))
            .isEqualTo("“Hallå, hallå”\nÅÄÖ åäö")
        assertThat(sanitizeG1DisplayText("Halla\u030A, halla\u030A"))
            .isEqualTo("Hallå, hallå")
    }

    @Test
    fun `preserves other scripts and is idempotent`() {
        val otherScripts = "が カ\u3099 한\u302E Α\u0301 مُرَحَّبًا शि ❤️"
        assertThat(sanitizeG1DisplayText(otherScripts)).isEqualTo(otherScripts)
        val normalized = sanitizeG1DisplayText("Hallå Łódź Đặng Œuvre")
        assertThat(normalized).isEqualTo("Hallå Łódź Dang OEuvre")
        assertThat(sanitizeG1DisplayText(normalized)).isEqualTo(normalized)
    }

    @Test
    fun `preserves every embedded extended Latin glyph in composed and decomposed forms`() {
        val glyphs = "ÀÂÇÈÉÊËÎÏÔÙÛÜàçèéêëîïôùûüÿŸÄäÖößẞâÁáÍíÑñúÓóÚⁱĲĳŠšŽžÃÅÆÌÐÒÕØÝÞãåæìðòõøýþĄąĆćČčĎďĘęĚěĞğŁłŃńŇňŘřŚśŞşŤťŮůŹźŻżĂăıȘșȚțǖǘǚǜǎǐǒǔŐőŰű"
        assertThat(sanitizeG1DisplayText(glyphs)).isEqualTo(glyphs)
        val decomposed = java.text.Normalizer.normalize(glyphs, java.text.Normalizer.Form.NFD)
        assertThat(sanitizeG1DisplayText(decomposed)).isEqualTo(glyphs)
    }
}
