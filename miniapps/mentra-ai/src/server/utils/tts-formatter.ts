/**
 * TTS (Text-to-Speech) Formatter
 *
 * Formats text for natural speech output on speaker glasses.
 * Converts numbers, symbols, and abbreviations to spoken form.
 */

/**
 * Number words for conversion
 */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * Convert a number to words
 * @param num The number to convert
 * @returns The number as words
 */
function numberToWords(num: number): string {
  if (!Number.isFinite(num)) return String(num);

  const absNum = Math.abs(num);
  const isNegative = num < 0;

  // Handle decimals
  if (!Number.isInteger(absNum)) {
    const [intPart, decPart] = absNum.toString().split('.');
    const intWords = numberToWords(parseInt(intPart, 10));
    const decWords = decPart.split('').map(d => ONES[parseInt(d, 10)]).join(' ');
    return (isNegative ? 'negative ' : '') + intWords + ' point ' + decWords;
  }

  if (absNum < 20) {
    return (isNegative ? 'negative ' : '') + ONES[absNum];
  }

  if (absNum < 100) {
    const ten = Math.floor(absNum / 10);
    const one = absNum % 10;
    return (isNegative ? 'negative ' : '') + TENS[ten] + (one ? '-' + ONES[one] : '');
  }

  if (absNum < 1000) {
    const hundred = Math.floor(absNum / 100);
    const remainder = absNum % 100;
    return (isNegative ? 'negative ' : '') + ONES[hundred] + ' hundred' + (remainder ? ' ' + numberToWords(remainder) : '');
  }

  if (absNum < 1000000) {
    const thousand = Math.floor(absNum / 1000);
    const remainder = absNum % 1000;
    return (isNegative ? 'negative ' : '') + numberToWords(thousand) + ' thousand' + (remainder ? ' ' + numberToWords(remainder) : '');
  }

  if (absNum < 1000000000) {
    const million = Math.floor(absNum / 1000000);
    const remainder = absNum % 1000000;
    return (isNegative ? 'negative ' : '') + numberToWords(million) + ' million' + (remainder ? ' ' + numberToWords(remainder) : '');
  }

  // For very large numbers, just return as-is
  return (isNegative ? 'negative ' : '') + absNum.toString();
}

/**
 * Format text for TTS output
 * Converts numbers, symbols, and abbreviations to spoken form.
 *
 * @param text The text to format
 * @returns Text formatted for natural speech
 */
export function formatForTTS(text: string): string {
  let result = text;

  // Temperature: "72°F" -> "seventy-two degrees fahrenheit"
  result = result.replace(/(\d+(?:\.\d+)?)\s*°\s*F\b/gi, (_, num) => {
    return numberToWords(parseFloat(num)) + ' degrees fahrenheit';
  });

  // Temperature: "22°C" -> "twenty-two degrees celsius"
  result = result.replace(/(\d+(?:\.\d+)?)\s*°\s*C\b/gi, (_, num) => {
    return numberToWords(parseFloat(num)) + ' degrees celsius';
  });

  // Generic degrees: "45°" -> "forty-five degrees"
  result = result.replace(/(\d+(?:\.\d+)?)\s*°/g, (_, num) => {
    return numberToWords(parseFloat(num)) + ' degrees';
  });

  // Currency: "$999" -> "nine hundred ninety-nine dollars"
  result = result.replace(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/g, (_, num) => {
    const cleanNum = num.replace(/,/g, '');
    const parts = cleanNum.split('.');
    let words = numberToWords(parseInt(parts[0], 10)) + ' dollars';
    if (parts[1] && parseInt(parts[1], 10) > 0) {
      words += ' and ' + numberToWords(parseInt(parts[1], 10)) + ' cents';
    }
    return words;
  });

  // Percentage: "45%" -> "forty-five percent"
  result = result.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, num) => {
    return numberToWords(parseFloat(num)) + ' percent';
  });

  // Times: "3:30" -> "three thirty" or "3:00" -> "three o'clock"
  result = result.replace(/(\d{1,2}):(\d{2})(?:\s*(AM|PM|am|pm))?/g, (_, hours, minutes, ampm) => {
    const h = parseInt(hours, 10);
    const m = parseInt(minutes, 10);
    let timeWords = numberToWords(h);

    if (m === 0) {
      timeWords += " o'clock";
    } else if (m < 10) {
      timeWords += ' oh ' + numberToWords(m);
    } else {
      timeWords += ' ' + numberToWords(m);
    }

    if (ampm) {
      timeWords += ' ' + ampm.toUpperCase().split('').join(' ');
    }

    return timeWords;
  });

  // Standalone numbers: "42" -> "forty-two" (only if not part of a word)
  result = result.replace(/\b(\d+(?:\.\d+)?)\b/g, (_, num) => {
    return numberToWords(parseFloat(num));
  });

  // Common abbreviations
  result = result.replace(/\be\.g\./gi, 'for example');
  result = result.replace(/\bi\.e\./gi, 'that is');
  result = result.replace(/\betc\./gi, 'et cetera');
  result = result.replace(/\bvs\./gi, 'versus');
  result = result.replace(/\bDr\./gi, 'Doctor');
  result = result.replace(/\bMr\./gi, 'Mister');
  result = result.replace(/\bMrs\./gi, 'Missus');
  result = result.replace(/\bMs\./gi, 'Miss');
  result = result.replace(/\bSt\./gi, 'Street');
  result = result.replace(/\bAve\./gi, 'Avenue');
  result = result.replace(/\bBlvd\./gi, 'Boulevard');

  // Units
  result = result.replace(/\bkm\b/gi, 'kilometers');
  result = result.replace(/\bmi\b/gi, 'miles');
  result = result.replace(/\bmph\b/gi, 'miles per hour');
  result = result.replace(/\bkph\b/gi, 'kilometers per hour');
  result = result.replace(/\blbs?\b/gi, 'pounds');
  result = result.replace(/\bkg\b/gi, 'kilograms');
  result = result.replace(/\bft\b/gi, 'feet');
  // "in" removed — too easily matches the preposition "in"
  result = result.replace(/\bcm\b/gi, 'centimeters');
  result = result.replace(/\bmm\b/gi, 'millimeters');

  // Clean up extra whitespace
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
