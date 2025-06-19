/**
 * Utility class for MongoDB document key sanitization.
 * MongoDB doesn't allow dots in field names as they're used for nested field access.
 * This utility replaces dots with fullwidth period (\uff0E) when storing data
 * and converts them back when retrieving data.
 */
export class MongoSanitizer {
  // The Unicode fullwidth period character to replace dots with
  private static readonly DOT_REPLACEMENT = '\uff0E';

  /**
   * Sanitizes a key for storage in MongoDB by replacing dots with fullwidth period.
   * @param key The original key
   * @returns The sanitized key
   */
  public static sanitizeKey(key: string): string {
    if (!key) return key;
    return key.replace(/\./g, this.DOT_REPLACEMENT);
  }

  /**
   * Restores a key from MongoDB by replacing fullwidth periods with regular dots.
   * @param key The sanitized key
   * @returns The original key
   */
  public static restoreKey(key: string): string {
    if (!key) return key;
    return key.replace(new RegExp(this.DOT_REPLACEMENT, 'g'), '.');
  }
} 