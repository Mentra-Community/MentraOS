/**
 * Options for text wrapping.
 */
export interface WrapOptions {
  /** Maximum width in pixels (defaults to profile's displayWidthPx) */
  maxWidthPx?: number;

  /** Maximum number of lines (defaults to profile's maxLines) */
  maxLines?: number;

  /** Maximum total bytes (defaults to profile's maxPayloadBytes) */
  maxBytes?: number;

  /**
   * Break mode:
   * - 'character': Break mid-word with hyphen for 100% utilization
   * - 'word': Break at word boundaries, hyphenate only if word > line
   * - 'strict-word': Break at word boundaries only, truncate long words
   */
  breakMode?: BreakMode;

  /** Character to use for hyphenation (default: '-') */
  hyphenChar?: string;

  /** Minimum characters before allowing hyphen break (default: 3) */
  minCharsBeforeHyphen?: number;

  /** Whether to trim whitespace from line ends (default: true) */
  trimLines?: boolean;

  /** Whether to preserve explicit newlines in input (default: true) */
  preserveNewlines?: boolean;
}

/**
 * Break mode for text wrapping.
 * - 'character': Break mid-word with hyphen for 100% utilization
 * - 'character-no-hyphen': Break mid-word without hyphen (clean break)
 * - 'word': Break at word boundaries, hyphenate only if word > line
 * - 'strict-word': Break at word boundaries only, truncate long words
 */
export type BreakMode = "character" | "character-no-hyphen" | "word" | "strict-word";

/**
 * Result of wrapping operation.
 */
export interface WrapResult {
  /** Wrapped lines */
  lines: string[];

  /** Whether content was truncated to fit constraints */
  truncated: boolean;

  /** Total pixel width of widest line */
  maxLineWidthPx: number;

  /** Total byte size of all lines */
  totalBytes: number;

  /** Per-line metadata */
  lineMetrics: LineMetrics[];

  /** Original input text */
  originalText: string;

  /** Break mode used */
  breakMode: BreakMode;
}

/**
 * Per-line metrics from wrapping.
 */
export interface LineMetrics {
  /** The line text */
  text: string;

  /** Width in pixels */
  widthPx: number;

  /** Byte size of this line */
  bytes: number;

  /** Utilization percentage (widthPx / maxWidthPx * 100) */
  utilizationPercent: number;

  /** Whether this line ends with a hyphen from breaking */
  endsWithHyphen: boolean;

  /** Whether this line was created from an explicit newline */
  fromExplicitNewline: boolean;
}

/**
 * Default wrap options.
 */
export const DEFAULT_WRAP_OPTIONS: Required<Omit<WrapOptions, "maxWidthPx" | "maxLines" | "maxBytes">> = {
  breakMode: "character-no-hyphen",
  hyphenChar: "-",
  minCharsBeforeHyphen: 3,
  trimLines: true,
  preserveNewlines: true,
};
