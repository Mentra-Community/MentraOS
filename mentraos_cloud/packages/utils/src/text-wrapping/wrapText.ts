export function wrapText(text: any, maxLength = 25): string {
  // Ensure text is a string
  // console.log("text", text);

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

          // If a single word is too long, hardcut it.
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
