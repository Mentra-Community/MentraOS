package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class G1TextSanitizerTest {

    @Test
    fun `strips Vietnamese diacritics unsupported by G1`() {
        assertThat(sanitizeG1DisplayText("Tiếng Việt: Đặng, Nguyễn, phở bò"))
            .isEqualTo("Tieng Viet: Dang, Nguyen, pho bo")
    }

    @Test
    fun `handles decomposed marks and preserves layout`() {
        assertThat(sanitizeG1DisplayText("Cafe\u0301\nĐa Nang"))
            .isEqualTo("Cafe\nDa Nang")
    }

    @Test
    fun `leaves text without diacritics unchanged`() {
        assertThat(sanitizeG1DisplayText("Hello, world! 123"))
            .isEqualTo("Hello, world! 123")
    }
}
