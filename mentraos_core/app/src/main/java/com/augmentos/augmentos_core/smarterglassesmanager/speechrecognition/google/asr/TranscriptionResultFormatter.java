/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr;

import android.graphics.Color;
import android.graphics.Typeface;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.SpannedString;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.TimeUtil;
import com.google.audio.asr.TranscriptionResult;
import com.google.audio.asr.TranscriptionResultFormatterOptions;
import com.google.common.base.Strings;
import com.google.common.collect.ImmutableList;
import com.google.common.collect.Lists;

import org.joda.time.Duration;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;

/**
 * Creates a colored transcript in the format of {@link SpannedString} from {@link
 * TranscriptionResult} according to the configuration of {@link Options}.
 *
 * <p>This class is not thread-safe. If you intend to use this from multiple threads, consider
 * SafeTranscriptionResultFormatter.
 */
public class TranscriptionResultFormatter {
  private static final String WHITE = "#ffffffff"; // Alpha: 1
  private static final String BLACK = "#de000000"; // Alpha: .87
  // Color gradients can be generated using http://www.perbang.dk/rgbgradient/.
  // In order of ascending confidence.
  private static final ImmutableList<String> LIGHT_THEME_COLORS =
      ImmutableList.of("#004ffa", "#1b55c8", "#375b96", "#526164", "#6e6732", "#8a6e00");
  private static final ImmutableList<String> DARK_THEME_COLORS =
      ImmutableList.of("#004ffa", "#306dc8", "#608c69", "#90aa64", "#c0c932", "#ffff00");
  private static final ImmutableList<String> SPEAKER_ID_COLORS =
      ImmutableList.of(
          "#4285f4", // blue
          "#ea4335", // red
          "#fbbc04", // yellow
          "#34a853", // green
          "#FA7B17", // orange
          "#F439A0", // pink
          "#A142F4", // purple
          "#24C1E0" // cyan
      );

  private static final ImmutableList<Double> UPPER_CONFIDENCE_THRESHOLDS =
      ImmutableList.of(0.3, 0.55, 0.7, 0.8, 0.9, Double.POSITIVE_INFINITY);

  // The separator regex used to split a concatenated string of word values.
  private static final String JAPANESE_SPLITTER_REGEX = "\\|";

  public static TranscriptionResultFormatterOptions noFormattingOptions() {
    return TranscriptionResultFormatterOptions.newBuilder()
        .setNumExtendedSilenceLineBreaks(0)
        .setNumLanguageSwitchLineBreaks(1)
        .setItalicizeCurrentHypothesis(false)
        .setTranscriptColoringStyle(TranscriptionResultFormatterOptions.TranscriptColoringStyle.NO_COLORING)
        .setTextColormap(TranscriptionResultFormatterOptions.TextColormap.DARK_THEME)
        .build();
  }

  /** Formatted text and the TranscriptionResult that produced it. */
  private static class CachedResult {
    public Spanned text;
    public TranscriptionResult result;
    public Spanned leadingWhitespace;

    CachedResult(TranscriptionResult result, Spanned text, Spanned leadingWhitespace) {
      this.result = result;
      this.text = text;
      this.leadingWhitespace = leadingWhitespace;
    }

    CharSequence getFormattedText() {
      return TextUtils.concat(leadingWhitespace, text);
    }
  }

  private TranscriptionResultFormatterOptions options;

  private Deque<CachedResult> resultsDeque = new ArrayDeque<>();

  private TranscriptionResult currentHypothesis;

  // A stored string of whitespace to add between extended silences.
  private String silenceLineBreak;
  // A stored string of whitespace to add between extended language switch.
  private String languageSwitchLineBreak;
  // A joda.org.Duration version of the options field of the same name.
  private Duration extendedSilenceDurationForLineBreaks;

  // The index of the last speaker contained in the most recently finalized result. -1 indicates
  // that no results have been seen.
  private int lastSpeakerId = -1;

  public TranscriptionResultFormatter() {
    setOptions(noFormattingOptions());
  }

  public TranscriptionResultFormatter(TranscriptionResultFormatterOptions options) {
    setOptions(options);
    reset();
  }

  /**
   * Sets the formatter options, which may include settings of current hypotheses in italics or
   * color transcripts by confidence.
   */
  public void setOptions(TranscriptionResultFormatterOptions options) {
    this.options = options.toBuilder().build();

    lastSpeakerId = -1;
    // Prepare the whitespace string.
    silenceLineBreak = createLineBreakString(options.getNumExtendedSilenceLineBreaks());
    languageSwitchLineBreak = createLineBreakString(options.getNumLanguageSwitchLineBreaks());
    extendedSilenceDurationForLineBreaks =
        TimeUtil.convert(options.getExtendedSilenceDurationForLineBreaks());

    // Reformat the old list.
    Deque<CachedResult> oldResultsDeque = resultsDeque;
    resultsDeque = new ArrayDeque<>();
    for (CachedResult oldResult : oldResultsDeque) {
      addFinalizedResult(oldResult.result);
    }
  }

  /**
   * Creates the line break string.
   *
   * @param lineBreakCount line break count in the string.
   * @return the line break string according to the lineBreakCount.
   */
  private String createLineBreakString(int lineBreakCount) {
    return Strings.repeat("\n", lineBreakCount);
  }

  /** Reset to initial state, before any calls to addFinalizedResult() or setCurrentHypothesis(). */
  public void reset() {
    resultsDeque.clear();
    lastSpeakerId = -1;
    clearCurrentHypothesis();
  }

  /**
   * Commits a result to the final transcript.
   *
   * <p>NOTE: This does not clear the hypothesis. Users who get partial results (hypotheses) should
   * prefer calling setCurrentHypothesis(...) and then finalizeCurrentHypothesis().
   */
  public void addFinalizedResult(TranscriptionResult resultSingleUtterance) {
    String lineBreak = obtainLineBreaksFromLastFinalizedResult(resultSingleUtterance);
    resultsDeque.add(
        new CachedResult(
            resultSingleUtterance.toBuilder().build(),
            formatSingleFinalized(resultSingleUtterance, !lineBreak.isEmpty()),
            SpannedString.valueOf(lineBreak)));
    lastSpeakerId = getLastSpeakerIdTag(resultSingleUtterance);
  }

  /**
   * Removes the current hypothesis so that only the finalized results will be in the transcript.
   */
  public void clearCurrentHypothesis() {
    currentHypothesis = null;
  }

  /**
   * Commits the currently stored hypothesis to the finalized text buffer and clears the hypothesis.
   *
   * @return true if it has results to finalize, otherwise false.
   */
  public boolean finalizeCurrentHypothesis() {
    if (currentHypothesis == null) {
      return false;
    }

    addFinalizedResult(currentHypothesis);
    clearCurrentHypothesis();
    return true;
  }

  /**
   * Sets the estimate of the current text, this result is expected to change. Once it is done
   * changing, commit it, by passing it to addFinalizedResult().
   */
  public void setCurrentHypothesis(TranscriptionResult resultSingleUtterance) {
    currentHypothesis = resultSingleUtterance.toBuilder().build();
  }

  /** Returns the current finalized text with the hypothesis appended to the end. */
  public Spanned getFormattedTranscript() {
    SpannableStringBuilder builder = new SpannableStringBuilder();
    for (CachedResult timestampedAndCachedResult : resultsDeque) {
      builder.append(timestampedAndCachedResult.getFormattedText());
    }
    builder.append(getFormattedHypothesis());

    return new SpannedString(builder);
  }

  /** Returns the latest sentence from transcription result. */
  public Spanned getMostRecentTranscriptSegment() {
    SpannableStringBuilder builder = new SpannableStringBuilder();
    builder.append(getFormattedHypothesis());
    if (!TextUtils.isEmpty(builder)) {
      return new SpannedString(builder);
    }

    if (!resultsDeque.isEmpty()) {
      CachedResult timestampedAndCachedResult = resultsDeque.getLast();
      builder.append(timestampedAndCachedResult.getFormattedText());
    }

    return new SpannedString(builder);
  }

  /** Get the transcription's duration time. */
  public Duration getTranscriptDuration() {
    if (resultsDeque.isEmpty()) {
      return Duration.ZERO;
    }
    return new Duration(
        TimeUtil.toInstant(resultsDeque.peekFirst().result.getStartTimestamp()),
        TimeUtil.toInstant(resultsDeque.peekLast().result.getEndTimestamp()));
  }

  private Spannable getFormattedHypothesis() {
    if (currentHypothesis == null) {
      return new SpannableString("");
    }

    SpannableStringBuilder spannableStringBuilder = new SpannableStringBuilder();
    String lineBreak = obtainLineBreaksFromLastFinalizedResult(currentHypothesis);
    boolean precededByLineBreak = !lineBreak.isEmpty();
    if (precededByLineBreak) {
      spannableStringBuilder.append(lineBreak);
    }
    spannableStringBuilder.append(formatHypothesis(currentHypothesis, precededByLineBreak));

    return SpannableString.valueOf(spannableStringBuilder);
  }

  private Spannable formatHypothesis(TranscriptionResult result, boolean precededByLineBreak) {
    Spannable spannable = formatSingleFinalized(result, precededByLineBreak);
    if (options.getItalicizeCurrentHypothesis()) {
      spannable.setSpan(
          new StyleSpan(Typeface.ITALIC),
          0,
          spannable.length(),
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
    return spannable;
  }

  /** A function that maps a Word to a six digit hex color (e.g. #a0b341). */
  private interface ColorByWordFunction {
    String getColor(TranscriptionResult.Word w);
  }

  /**
   * Format a single result. precededByLineBreak is used to determine if a speaker indicator should
   * be added to reestablish context after a newline.
   */
  private Spannable formatSingleFinalized(
      TranscriptionResult result, boolean precededByLineBreak) {
    // Trim leading spaces, but ensure that there will be a space before the next word.
    String normalizedTranscript = result.getText().trim() + " ";
    if (result.getWordLevelDetailList().isEmpty()) {
      // Process the transcript as a whole.
      String color = "";
      switch (options.getTranscriptColoringStyle()) {
        case COLOR_BY_SPEAKER_ID:
          color = getColorFromSpeakerId(result.getSpeakerInfo().getSpeakerId());
          break;
        case COLOR_BY_UTTERANCE_LEVEL_CONFIDENCE:
          color = getColorFromConfidence(result);
          break;
        case COLOR_BY_WORD_LEVEL_CONFIDENCE:
        case NO_COLORING:
        case UNSPECIFIED_COLORING_STYLE:
          color = getDefaultColorFromTheme();
          break;
      }
      if (options.getSpeakerIndicationStyle() == TranscriptionResultFormatterOptions.SpeakerIndicationStyle.SHOW_SPEAKER_NUMBER
          && (precededByLineBreak || result.getSpeakerInfo().getSpeakerId() != lastSpeakerId)) {
        boolean requiresLineBreak = lastSpeakerId != -1 && !precededByLineBreak;
        normalizedTranscript =
            newSpeakerChevron(result.getSpeakerInfo().getSpeakerId(), requiresLineBreak)
                + normalizedTranscript;
      }
      // Make sure the utterance ends in a trailing space so that words don't get merged together.
      return makeColoredString(normalizedTranscript, color);
    } else {
      // Process each word of the transcript separately.
      ColorByWordFunction colorFunction = w -> getDefaultColorFromTheme();
      switch (options.getTranscriptColoringStyle()) {
        case COLOR_BY_WORD_LEVEL_CONFIDENCE:
          colorFunction = word -> getColorFromConfidence(word.getConfidence());
          break;
        case COLOR_BY_UTTERANCE_LEVEL_CONFIDENCE:
          colorFunction = word -> getColorFromConfidence(result); // Word-independent.
          break;
        case COLOR_BY_SPEAKER_ID:
          colorFunction = word -> getColorFromSpeakerId(word.getSpeakerInfo().getSpeakerId());
          break;
        case NO_COLORING:
        case UNSPECIFIED_COLORING_STYLE:
          colorFunction = word -> getDefaultColorFromTheme();
          break;
      }
      return addPerWordColoredStringToResult(
          normalizedTranscript,
          result.getLanguageCode(),
          result.getWordLevelDetailList(),
          precededByLineBreak,
          colorFunction);
    }
  }

  /**
   * Obtains line breaks between the last finalized result and current result. It would return an
   * empty string if no finalized transcript result existed. (Current result is he first element.)
   */
  private String obtainLineBreaksFromLastFinalizedResult(TranscriptionResult current) {
    return resultsDeque.isEmpty()
        ? ""
        : obtainLineBreaksBetweenTwoResults(resultsDeque.getLast(), current);
  }

  private String obtainLineBreaksBetweenTwoResults(
      CachedResult previous, TranscriptionResult current) {
    boolean languageSwitched = !previous.result.getLanguageCode().equals(current.getLanguageCode());
    if (options.getNumExtendedSilenceLineBreaks() > 0) { // Previous element is not whitespace.
      Duration timestampDifference =
          new Duration(
              TimeUtil.toInstant(previous.result.getEndTimestamp()),
              TimeUtil.toInstant(current.getStartTimestamp()));
      if (timestampDifference.isLongerThan(extendedSilenceDurationForLineBreaks)) {
        // If language switch and silence both happened, return the longer line break.
        return languageSwitched ? getLineBreaksWhenSilenceAndLanguageSwitch() : silenceLineBreak;
      }
    }
    return languageSwitched ? languageSwitchLineBreak : "";
  }

  /** Returns the String contains more new line breaks between language switch and silence. */
  private String getLineBreaksWhenSilenceAndLanguageSwitch() {
    if (options.getNumExtendedSilenceLineBreaks() >= options.getNumLanguageSwitchLineBreaks()) {
      return silenceLineBreak;
    }
    return languageSwitchLineBreak;
  }

  private static String getLanguageWithoutDialect(String languageCode) {
    if (TextUtils.isEmpty(languageCode)) {
      return "";
    }
    return languageCode.split("-", -1)[0];
  }

  /**
   * Returns string with Hiragana only if language is Japanese. Otherwise, returned string is with
   * any leading and trailing whitespace removed.
   */
  private static String formatWord(String languageCode, String word) {
    String language = getLanguageWithoutDialect(languageCode);
    if ("ja".equalsIgnoreCase(language)) {
      // Japanese ASR results could contain two parts per word, the former would be one of
      // Hiragana, Katakana, or Kanji, and the latter would be Katakana or none. Here extract
      // the former.
      return word.split(JAPANESE_SPLITTER_REGEX, -1)[0];
    }
    return word.trim();
  }

  /**
   * If the word occurs as a substring within the rawTranscript, then the substring starting from
   * the last occurrence of the word and extends to the end is added to intermediateBuilder. We
   * assume the transcript is formatted perfectly, and then we don't worry about the word divider
   * between words for all languages if we construct the transcript by words level detail.
   */
  private static boolean checkWordExistedThenAdd(
      StringBuilder rawTranscript, StringBuilder intermediateBuilder, String word) {
    int index = rawTranscript.lastIndexOf(word);
    if (index == -1) {
      return false;
    }
    String transcriptToTheEnd = rawTranscript.substring(index);
    intermediateBuilder.insert(0, transcriptToTheEnd);
    rawTranscript.delete(index, rawTranscript.length());
    return true;
  }

  /**
   * Generates a Spannable with text formatted at the word level.
   *
   * @param wholeStringTranscript the whole transcript, formatted to have no leading spaces and a
   *     single trailing space
   * @param languageCode string language code, for example "en-us" or "ja"
   * @param words the list of words contained in wholeStringTranscript
   * @param colorFunction maps a word to a hex color
   */
  private Spannable addPerWordColoredStringToResult(
      String wholeStringTranscript,
      String languageCode,
      List<TranscriptionResult.Word> words,
      boolean precededByLineBreak,
      ColorByWordFunction colorFunction) {
    StringBuilder rawTranscript = new StringBuilder(wholeStringTranscript);
    boolean wordFound = false;
    String color = "";
    SpannableStringBuilder spannableStringBuilder = new SpannableStringBuilder();
    StringBuilder intermediateBuilder = new StringBuilder();
    // Group adjacent words of the same color within the same span tag.
    // Traverse in reverse then a space divider will be at the end of word.
    List<TranscriptionResult.Word> reverseWords = Lists.reverse(words);
    for (int wordIndex = 0; wordIndex < reverseWords.size(); ++wordIndex) {
      TranscriptionResult.Word word = reverseWords.get(wordIndex);

      String nextColor = colorFunction.getColor(word);
      if (wordFound) {
        if (!color.equals(nextColor)) {
          spannableStringBuilder.insert(
              0, makeColoredString(intermediateBuilder.toString(), color));
          intermediateBuilder = new StringBuilder();
          wordFound = false;
        }

        if (options.getSpeakerIndicationStyle() == TranscriptionResultFormatterOptions.SpeakerIndicationStyle.SHOW_SPEAKER_NUMBER) {
          // If the speaker has changed or if the text was preceded by a space, add a chevron.
          int previousSpeaker = reverseWords.get(wordIndex - 1).getSpeakerInfo().getSpeakerId();
          if (word.getSpeakerInfo().getSpeakerId() != previousSpeaker) {
            boolean needsAdditionalNewline = previousSpeaker != -1 && !precededByLineBreak;
            intermediateBuilder.insert(
                0,
                newSpeakerChevron(
                    reverseWords.get(wordIndex - 1).getSpeakerInfo().getSpeakerId(),
                    needsAdditionalNewline));

            spannableStringBuilder.insert(
                0, makeColoredString(intermediateBuilder.toString(), color));
            intermediateBuilder = new StringBuilder();
            wordFound = false;
          }
        }
      }
      // We'll try to find previous word if we can't find current word in the rawTranscript.
      // Append the string started from the word to the end if found.
      wordFound |=
          checkWordExistedThenAdd(
              rawTranscript, intermediateBuilder, formatWord(languageCode, word.getText()));
      color = nextColor;
    }
    boolean forceChevron =
        precededByLineBreak || words.get(0).getSpeakerInfo().getSpeakerId() != lastSpeakerId;
    intermediateBuilder.insert(0, rawTranscript.toString());
    if (options.getSpeakerIndicationStyle() == TranscriptionResultFormatterOptions.SpeakerIndicationStyle.SHOW_SPEAKER_NUMBER
        && intermediateBuilder.length() != 0
        && forceChevron) {
      intermediateBuilder.insert(
          0,
          newSpeakerChevron(
              words.get(0).getSpeakerInfo().getSpeakerId(),
              lastSpeakerId != -1 && !precededByLineBreak));
    }
    spannableStringBuilder.insert(0, makeColoredString(intermediateBuilder.toString(), color));
    return SpannableString.valueOf(spannableStringBuilder);
  }

  /**
   * Generates a {@link SpannableString} containing a colored string.
   *
   * @param message a string to append to cachedFinalizedResult
   * @param color a six-character hex string beginning with a pound sign
   */
  private SpannableString makeColoredString(String message, String color) {
    int textColor = Color.parseColor(color);
    SpannableString spannableString = new SpannableString(message);
    spannableString.setSpan(
        new ForegroundColorSpan(textColor),
        0,
        spannableString.length(),
        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
    return spannableString;
  }

  /**
   * Get a string hex color associated with a confidence value on the range [0, 1] according to the
   * confidence in {@link TranscriptionResult}.
   */
  private String getColorFromConfidence(TranscriptionResult result) {
    if (result.hasConfidence()) {
      return getColorFromConfidence(result.getConfidence());
    }
    return getDefaultColorFromTheme();
  }

  /**
   * Get a string hex color associated with a confidence value on the range [0, 1] according to
   * specified confidence.
   */
  private String getColorFromConfidence(float confidence) {
    ImmutableList<String> colormap = getColorList(options.getTextColormap());
    for (int i = 0; i < UPPER_CONFIDENCE_THRESHOLDS.size(); ++i) {
      if (confidence <= UPPER_CONFIDENCE_THRESHOLDS.get(i)) {
        return colormap.get(i);
      }
    }
    // Won't happen because upper bound of UPPER_CONFIDENCE_THRESHOLDS is infinity.
    return getDefaultColorFromTheme();
  }

  /** Returns the hex code of the default text color according to the theme. */
  private String getDefaultColorFromTheme() {
    switch (options.getTextColormap()) {
      case DARK_THEME:
        return WHITE;
      case LIGHT_THEME:
      case UNSPECIFIED_THEME:
        return BLACK;
    }
    return WHITE;
  }

  /**
   * Get a string hex color associated with the speaker number. Currently this supports up to 4
   * speakers.
   */
  private String getColorFromSpeakerId(int speakerID) {
    return SPEAKER_ID_COLORS.get(speakerID % SPEAKER_ID_COLORS.size());
  }

  private static ImmutableList<String> getColorList(TranscriptionResultFormatterOptions.TextColormap colormap) {
    switch (colormap) {
      case LIGHT_THEME:
      case UNSPECIFIED_THEME:
        return LIGHT_THEME_COLORS;
      case DARK_THEME:
        return DARK_THEME_COLORS;
    }
    return DARK_THEME_COLORS;
  }

  private static String newSpeakerChevron(int tag, boolean includesNewline) {
    return (includesNewline ? "\n≫ " : "≫ ") + Integer.toString(tag) + ": ";
  }

  private static int getLastSpeakerIdTag(TranscriptionResult result) {
    if (result.getWordLevelDetailCount() == 0) {
      return result.getSpeakerInfo().getSpeakerId();
    } else {
      return result
          .getWordLevelDetailList()
          .get(result.getWordLevelDetailCount() - 1)
          .getSpeakerInfo()
          .getSpeakerId();
    }
  }
}
