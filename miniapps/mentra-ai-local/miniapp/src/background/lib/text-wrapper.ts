/**
 * Text Wrapping Utilities
 *
 * Utilities for formatting text for HUD display on smart glasses.
 */

/**
 * Converts a line width setting to a numeric character count
 * @param width The width setting as a string or number
 * @param isHanzi Whether the text uses Hanzi characters (Chinese, Japanese)
 * @returns The number of characters per line
 */
export function convertLineWidth(width: string | number, isHanzi: boolean): number {
  if (typeof width === 'number') return width;

  if (!isHanzi) {
    switch (width.toLowerCase()) {
      case 'very narrow': return 21;
      case 'narrow': return 30;
      case 'medium': return 38;
      case 'wide': return 44;
      case 'very wide': return 52;
      default: return 45;
    }
  } else {
    switch (width.toLowerCase()) {
      case 'very narrow': return 7;
      case 'narrow': return 10;
      case 'medium': return 14;
      case 'wide': return 18;
      case 'very wide': return 21;
      default: return 14;
    }
  }
}

/**
 * Wrap text to fit within a maximum line length
 * @param text The text to wrap
 * @param maxLength Maximum characters per line (default: 25)
 * @returns Text with newlines inserted for wrapping
 */
export function wrapText(text: any, maxLength = 25): string {
  // Ensure text is a string
  if (typeof text !== 'string' || text.length === 0) {
    return "";
  }

  return text
    .split('\n')
    .map(line => {
      const words = line.split(' ');
      let currentLine = '';
      const wrappedLines: string[] = [];

      words.forEach(word => {
        if ((currentLine.length + (currentLine ? 1 : 0) + word.length) <= maxLength) {
          currentLine += (currentLine ? ' ' : '') + word;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
          }
          currentLine = word;

          // If a single word is too long, hard-cut it.
          while (currentLine.length > maxLength) {
            wrappedLines.push(currentLine.slice(0, maxLength));
            currentLine = currentLine.slice(maxLength);
          }
        }
      });

      if (currentLine) {
        wrappedLines.push(currentLine.trim());
      }

      return wrappedLines.join('\n');
    })
    .join('\n');
}
