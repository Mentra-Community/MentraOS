import { TextMeasurer } from "../measurer/TextMeasurer";
import { isCJKCharacter, needsHyphenForBreak } from "../measurer/script-detection";
import type { WrapOptions, WrapResult, LineMetrics, BreakMode } from "./types";
import { DEFAULT_WRAP_OPTIONS } from "./types";

/**
 * Wraps text to fit display constraints.
 *
 * Supports multiple break modes:
 * - 'character': Break mid-word with hyphen for 100% line utilization
 * - 'word': Break at word boundaries, hyphenate only if word > line width
 * - 'strict-word': Break at word boundaries only, no hyphenation
 *
 * Key features:
 * - Pixel-accurate wrapping (no abstract units)
 * - Hyphen-aware breaking (accounts for hyphen width)
 * - CJK support (breaks anywhere without hyphen)
 * - Preserves explicit newlines
 * - Respects byte limits for BLE transmission
 */
export class TextWrapper {
  private readonly measurer: TextMeasurer;
  private readonly defaultOptions: Required<WrapOptions>;

  constructor(measurer: TextMeasurer, defaultOptions?: WrapOptions) {
    this.measurer = measurer;

    const profile = measurer.getProfile();
    this.defaultOptions = {
      maxWidthPx: profile.displayWidthPx,
      maxLines: profile.maxLines,
      maxBytes: profile.maxPayloadBytes,
      ...DEFAULT_WRAP_OPTIONS,
      ...defaultOptions,
    };
  }

  /**
   * Wrap text to fit within constraints.
   *
   * @param text - Text to wrap (may contain \n for explicit breaks)
   * @param options - Override default options
   * @returns Wrap result with lines and metadata
   */
  wrap(text: string, options?: WrapOptions): WrapResult {
    const opts = this.mergeOptions(options);
    const { maxWidthPx, maxLines, maxBytes, breakMode, preserveNewlines } = opts;

    if (!text || text.length === 0) {
      return this.createEmptyResult(opts);
    }

    // Split by explicit newlines if preserving them
    const paragraphs = preserveNewlines ? text.split("\n") : [text];

    const allLines: string[] = [];
    const allMetrics: LineMetrics[] = [];
    let totalBytes = 0;
    let truncated = false;

    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const paragraph = paragraphs[pIndex];
      const isFromNewline = pIndex > 0;

      // Wrap this paragraph
      const paragraphLines = this.wrapParagraph(paragraph, maxWidthPx, breakMode, opts);

      for (let lIndex = 0; lIndex < paragraphLines.length; lIndex++) {
        const line = paragraphLines[lIndex];
        const lineBytes = this.measurer.getByteSize(line);

        // Check if we've exceeded limits
        if (allLines.length >= maxLines) {
          truncated = true;
          break;
        }

        if (totalBytes + lineBytes > maxBytes) {
          truncated = true;
          break;
        }

        const widthPx = this.measurer.measureText(line);
        const metrics: LineMetrics = {
          text: line,
          widthPx,
          bytes: lineBytes,
          utilizationPercent: Math.round((widthPx / maxWidthPx) * 100),
          endsWithHyphen: line.endsWith(opts.hyphenChar) && lIndex < paragraphLines.length - 1,
          fromExplicitNewline: isFromNewline && lIndex === 0,
        };

        allLines.push(line);
        allMetrics.push(metrics);
        totalBytes += lineBytes;

        // Add newline byte between lines
        if (allLines.length < maxLines) {
          totalBytes += 1; // \n is 1 byte
        }
      }

      if (truncated) break;
    }

    // Find max line width
    const maxLineWidthPx = allMetrics.reduce((max, m) => Math.max(max, m.widthPx), 0);

    return {
      lines: allLines,
      truncated,
      maxLineWidthPx,
      totalBytes,
      lineMetrics: allMetrics,
      originalText: text,
      breakMode,
    };
  }

  /**
   * Simple wrap returning just lines (convenience method).
   *
   * @param text - Text to wrap
   * @param options - Override default options
   * @returns Array of wrapped lines
   */
  wrapToLines(text: string, options?: WrapOptions): string[] {
    return this.wrap(text, options).lines;
  }

  /**
   * Check if text needs wrapping.
   *
   * @param text - Text to check
   * @param maxWidthPx - Optional width override
   * @returns true if text exceeds single line
   */
  needsWrap(text: string, maxWidthPx?: number): boolean {
    const width = maxWidthPx ?? this.defaultOptions.maxWidthPx;
    return this.measurer.measureText(text) > width || text.includes("\n");
  }

  /**
   * Get current default options.
   */
  getOptions(): Required<WrapOptions> {
    return { ...this.defaultOptions };
  }

  /**
   * Get the measurer instance.
   */
  getMeasurer(): TextMeasurer {
    return this.measurer;
  }

  /**
   * Wrap a single paragraph (no newlines) according to break mode.
   */
  private wrapParagraph(
    paragraph: string,
    maxWidthPx: number,
    breakMode: BreakMode,
    opts: Required<WrapOptions>,
  ): string[] {
    const trimmed = opts.trimLines ? paragraph.trim() : paragraph;

    if (!trimmed) {
      return [""];
    }

    // Check if it fits on one line
    if (this.measurer.fitsInWidth(trimmed, maxWidthPx)) {
      return [trimmed];
    }

    switch (breakMode) {
      case "character":
        return this.wrapCharacterMode(trimmed, maxWidthPx, opts);
      case "character-no-hyphen":
        return this.wrapCharacterNoHyphenMode(trimmed, maxWidthPx, opts);
      case "word":
        return this.wrapWordMode(trimmed, maxWidthPx, opts);
      case "strict-word":
        return this.wrapStrictWordMode(trimmed, maxWidthPx, opts);
      default:
        return this.wrapCharacterMode(trimmed, maxWidthPx, opts);
    }
  }

  /**
   * Character break mode: Break mid-word with hyphen for 100% line utilization.
   */
  private wrapCharacterMode(text: string, maxWidthPx: number, opts: Required<WrapOptions>): string[] {
    return this.wrapCharacterModeInternal(text, maxWidthPx, opts, true);
  }

  /**
   * Character break mode without hyphen: Break mid-word cleanly without adding hyphen.
   */
  private wrapCharacterNoHyphenMode(text: string, maxWidthPx: number, opts: Required<WrapOptions>): string[] {
    return this.wrapCharacterModeInternal(text, maxWidthPx, opts, false);
  }

  /**
   * Internal character break implementation with configurable hyphenation.
   */
  private wrapCharacterModeInternal(
    text: string,
    maxWidthPx: number,
    opts: Required<WrapOptions>,
    useHyphen: boolean,
  ): string[] {
    const lines: string[] = [];
    const hyphenWidth = this.measurer.measureChar(opts.hyphenChar);

    let currentLine = "";
    let currentWidth = 0;

    const chars = Array.from(text);

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const charWidth = this.measurer.measureChar(char);

      // Would this character fit?
      if (currentWidth + charWidth <= maxWidthPx) {
        currentLine += char;
        currentWidth += charWidth;
      } else {
        // Character doesn't fit - need to break

        // Determine if we need a hyphen
        const prevChar = currentLine.length > 0 ? currentLine[currentLine.length - 1] : "";
        const needsHyphen =
          useHyphen && currentLine.length >= opts.minCharsBeforeHyphen && needsHyphenForBreak(prevChar, char);

        if (needsHyphen) {
          // Back off characters until hyphen fits
          const result = this.backoffForHyphen(currentLine, currentWidth, maxWidthPx, hyphenWidth, opts);

          if (result.skipHyphen) {
            // Found a natural word boundary while backing off - no hyphen needed
            lines.push(result.line);
          } else {
            lines.push(result.line + opts.hyphenChar);
          }

          // Start new line with backed-off chars + current char
          currentLine = result.remainder + char;
          currentWidth = this.measurer.measureText(currentLine);
        } else if (useHyphen === false && !isCJKCharacter(char) && char !== " ") {
          // No-hyphen mode: just break cleanly without hyphen
          const trimmedLine = opts.trimLines ? currentLine.trimEnd() : currentLine;
          if (trimmedLine) {
            lines.push(trimmedLine);
          }
          currentLine = char;
          currentWidth = charWidth;
        } else {
          // No hyphen needed (CJK, space, punctuation)
          const trimmedLine = opts.trimLines ? currentLine.trimEnd() : currentLine;
          if (trimmedLine) {
            lines.push(trimmedLine);
          }
          currentLine = char === " " ? "" : char;
          currentWidth = char === " " ? 0 : charWidth;
        }
      }
    }

    // Add remaining text
    if (currentLine) {
      const trimmedLine = opts.trimLines ? currentLine.trim() : currentLine;
      if (trimmedLine) {
        lines.push(trimmedLine);
      }
    }

    return lines.length > 0 ? lines : [""];
  }

  /**
   * Word break mode: Break at word boundaries, hyphenate only if word > line width.
   */
  private wrapWordMode(text: string, maxWidthPx: number, opts: Required<WrapOptions>): string[] {
    const lines: string[] = [];
    const words = this.splitIntoWords(text);
    const spaceWidth = this.measurer.getSpaceWidth();

    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = this.measurer.measureText(word);
      const needsSpace = currentLine.length > 0;
      const totalWidth = currentWidth + (needsSpace ? spaceWidth : 0) + wordWidth;

      if (totalWidth <= maxWidthPx) {
        // Word fits on current line
        if (needsSpace) {
          currentLine += " ";
          currentWidth += spaceWidth;
        }
        currentLine += word;
        currentWidth += wordWidth;
      } else {
        // Word doesn't fit
        if (currentLine.length > 0) {
          // Push current line and start new one
          lines.push(opts.trimLines ? currentLine.trim() : currentLine);
          currentLine = "";
          currentWidth = 0;
        }

        // Check if word itself exceeds line width
        if (wordWidth > maxWidthPx) {
          // Word is too long - hyphenate it
          const hyphenatedLines = this.hyphenateLongWord(word, maxWidthPx, opts);
          for (let i = 0; i < hyphenatedLines.length - 1; i++) {
            lines.push(hyphenatedLines[i]);
          }
          // Last piece becomes start of current line
          currentLine = hyphenatedLines[hyphenatedLines.length - 1];
          currentWidth = this.measurer.measureText(currentLine);
        } else {
          // Word fits on new line
          currentLine = word;
          currentWidth = wordWidth;
        }
      }
    }

    // Add remaining text
    if (currentLine) {
      const trimmedLine = opts.trimLines ? currentLine.trim() : currentLine;
      if (trimmedLine) {
        lines.push(trimmedLine);
      }
    }

    return lines.length > 0 ? lines : [""];
  }

  /**
   * Strict word break mode: Break at word boundaries only, no hyphenation.
   * Long words will overflow the line.
   */
  private wrapStrictWordMode(text: string, maxWidthPx: number, opts: Required<WrapOptions>): string[] {
    const lines: string[] = [];
    const words = this.splitIntoWords(text);
    const spaceWidth = this.measurer.getSpaceWidth();

    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = this.measurer.measureText(word);
      const needsSpace = currentLine.length > 0;
      const totalWidth = currentWidth + (needsSpace ? spaceWidth : 0) + wordWidth;

      if (totalWidth <= maxWidthPx) {
        // Word fits on current line
        if (needsSpace) {
          currentLine += " ";
          currentWidth += spaceWidth;
        }
        currentLine += word;
        currentWidth += wordWidth;
      } else {
        // Word doesn't fit
        if (currentLine.length > 0) {
          // Push current line
          lines.push(opts.trimLines ? currentLine.trim() : currentLine);
        }
        // Start new line with word (even if it overflows)
        currentLine = word;
        currentWidth = wordWidth;
      }
    }

    // Add remaining text
    if (currentLine) {
      const trimmedLine = opts.trimLines ? currentLine.trim() : currentLine;
      if (trimmedLine) {
        lines.push(trimmedLine);
      }
    }

    return lines.length > 0 ? lines : [""];
  }

  /**
   * Split text into words, handling CJK characters specially.
   * CJK characters are treated as individual "words" since they can break anywhere.
   */
  private splitIntoWords(text: string): string[] {
    const words: string[] = [];
    let currentWord = "";

    for (const char of text) {
      if (char === " " || char === "\t") {
        if (currentWord) {
          words.push(currentWord);
          currentWord = "";
        }
      } else if (isCJKCharacter(char)) {
        // CJK characters are individual words
        if (currentWord) {
          words.push(currentWord);
          currentWord = "";
        }
        words.push(char);
      } else {
        currentWord += char;
      }
    }

    if (currentWord) {
      words.push(currentWord);
    }

    return words;
  }

  /**
   * Hyphenate a word that's too long to fit on a single line.
   */
  private hyphenateLongWord(word: string, maxWidthPx: number, opts: Required<WrapOptions>): string[] {
    const lines: string[] = [];
    const hyphenWidth = this.measurer.measureChar(opts.hyphenChar);
    const chars = Array.from(word);

    let currentLine = "";
    let currentWidth = 0;

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const charWidth = this.measurer.measureChar(char);
      const isLastChar = i === chars.length - 1;

      // Check if we need to break (leaving room for hyphen if not last char)
      const widthNeeded = isLastChar ? charWidth : charWidth + hyphenWidth;

      if (currentWidth + widthNeeded <= maxWidthPx) {
        currentLine += char;
        currentWidth += charWidth;
      } else {
        // Need to break - back off if needed to fit hyphen
        if (currentLine.length >= opts.minCharsBeforeHyphen) {
          const result = this.backoffForHyphen(currentLine, currentWidth, maxWidthPx, hyphenWidth, opts);
          if (result.skipHyphen) {
            lines.push(result.line);
          } else {
            lines.push(result.line + opts.hyphenChar);
          }
          currentLine = result.remainder + char;
          currentWidth = this.measurer.measureText(currentLine);
        } else {
          // Not enough chars for hyphen, just break
          if (currentLine) {
            lines.push(currentLine);
          }
          currentLine = char;
          currentWidth = charWidth;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [word];
  }

  /**
   * Back off characters from line end until hyphen fits.
   * Returns null if we back off to a space (natural break point - no hyphen needed).
   */
  private backoffForHyphen(
    line: string,
    lineWidth: number,
    maxWidthPx: number,
    hyphenWidth: number,
    opts: Required<WrapOptions>,
  ): { line: string; remainder: string; skipHyphen: boolean } {
    let adjustedLine = line;
    let adjustedWidth = lineWidth;
    let remainder = "";

    // Remove characters until hyphen fits
    while (adjustedWidth + hyphenWidth > maxWidthPx && adjustedLine.length > opts.minCharsBeforeHyphen) {
      const lastChar = adjustedLine[adjustedLine.length - 1];
      const lastCharWidth = this.measurer.measureChar(lastChar);

      adjustedLine = adjustedLine.slice(0, -1);
      adjustedWidth -= lastCharWidth;
      remainder = lastChar + remainder;

      // If we've backed off to a space, we've found a natural word boundary
      // No hyphen is needed - just trim the space and break there
      if (adjustedLine.length > 0 && adjustedLine[adjustedLine.length - 1] === " ") {
        // Trim trailing space from the line
        adjustedLine = adjustedLine.trimEnd();
        return { line: adjustedLine, remainder, skipHyphen: true };
      }
    }

    return { line: adjustedLine, remainder, skipHyphen: false };
  }

  /**
   * Merge user options with defaults.
   */
  private mergeOptions(options?: WrapOptions): Required<WrapOptions> {
    return {
      ...this.defaultOptions,
      ...options,
    };
  }

  /**
   * Create an empty result for empty input.
   */
  private createEmptyResult(opts: Required<WrapOptions>): WrapResult {
    return {
      lines: [""],
      truncated: false,
      maxLineWidthPx: 0,
      totalBytes: 0,
      lineMetrics: [
        {
          text: "",
          widthPx: 0,
          bytes: 0,
          utilizationPercent: 0,
          endsWithHyphen: false,
          fromExplicitNewline: false,
        },
      ],
      originalText: "",
      breakMode: opts.breakMode,
    };
  }
}
