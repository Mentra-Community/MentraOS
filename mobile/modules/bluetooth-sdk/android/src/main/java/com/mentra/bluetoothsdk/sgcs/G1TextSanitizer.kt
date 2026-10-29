package com.mentra.bluetoothsdk.sgcs

import java.text.Normalizer

// Embedded G1 1.5.6 Latin glyphs. See notes/g1-character-support.md.
private const val G1_LATIN_GLYPHS = "ÀÂÇÈÉÊËÎÏÔÙÛÜàçèéêëîïôùûüÿŸÄäÖößẞâÁáÍíÑñúÓóÚⁱĲĳŠšŽžÃÅÆÌÐÒÕØÝÞãåæìðòõøýþĄąĆćČčĎďĘęĚěĞğŁłŃńŇňŘřŚśŞşŤťŮůŹźŻżĂăıȘșȚțǖǘǚǜǎǐǒǔŐőŰű"
private val G1_LATIN_CLUSTERS = Regex("\\p{IsLatin}\\p{M}*")

/** Preserves mapped Latin glyphs and falls back only for unmapped Latin clusters. */
internal fun sanitizeG1DisplayText(text: String): String = G1_LATIN_CLUSTERS.replace(text) { match ->
  val composed = Normalizer.normalize(match.value, Normalizer.Form.NFC)
  if (composed.length == 1 && (composed[0] in ' '..'~' || composed[0] in G1_LATIN_GLYPHS)) {
    composed
  } else {
    sanitizeLatinDisplayText(match.value, preserveOtherScripts = true)
  }
}
