/**
 * Composer Module
 *
 * Handles composition of multi-column and complex layouts for smart glasses displays.
 * This module provides the single source of truth for layout composition logic,
 * replacing duplicate implementations in native iOS and Android code.
 */

export {
  ColumnComposer,
  createColumnComposer,
  type ColumnConfig,
  type ComposeOptions,
  type ComposeResult,
} from "./ColumnComposer";
