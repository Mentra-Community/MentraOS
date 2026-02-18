/**
 * Display Formatter for G1
 * 
 * Formats mp-cli data for optimal display on Even Realities G1 glasses.
 * 
 * Constraints:
 * - Maximum 5 lines visible
 * - ~40-50 characters per line
 * - Plain text only (no formatting)
 * - Symbols work: → • (emojis may not render)
 */

interface Task {
  title?: string
  project?: string
  completion?: number
  ballInCourt?: string
}

interface StakeholderSignal {
  name?: string
  score?: number
  timeframe?: string
  days?: number
}

interface MpNextData {
  output?: string
}

export class DisplayFormatter {
  private static MAX_LINES = 5
  private static MAX_CHARS_PER_LINE = 45

  /**
   * Format mp next output for G1 display
   */
  public static formatNext(data: MpNextData): string {
    if (!data.output) {
      return 'No data available'
    }

    const output = data.output
    const lines: string[] = []

    // Parse the output
    const has98Items = output.includes('Items at 98%')
    const hasSignals = output.includes('COMMITMENT SIGNALS')

    // Extract 98% items
    const items98: string[] = []
    if (has98Items) {
      const match = output.match(/Items at 98%[^:]*:\n(.*?)(?=\n\n|Stakeholder Signals)/s)
      if (match) {
        const itemsText = match[1]
        if (itemsText.includes('No items needing attention')) {
          // No items
        } else {
          // Parse items (simplified for now)
          const itemLines = itemsText.split('\n').filter(l => l.trim().startsWith('✅') || l.trim().startsWith('-'))
          items98.push(...itemLines.slice(0, 3)) // Max 3 items
        }
      }
    }

    // Extract top signals
    const signals: Array<{name: string, score: string}> = []
    if (hasSignals) {
      const signalMatches = output.matchAll(/🔥 ([^(]+) \([^)]+\)\n\s+(\d+\/10)/g)
      for (const match of signalMatches) {
        signals.push({
          name: match[1].trim(),
          score: match[2]
        })
        if (signals.length >= 3) break
      }
    }

    // Build display (5 lines max)
    if (items98.length > 0) {
      // Show tasks
      lines.push(`-> NEXT (${items98.length})`)
      items98.slice(0, 3).forEach(item => {
        const cleaned = item.replace('✅', '•').trim()
        lines.push(this.truncate(cleaned, this.MAX_CHARS_PER_LINE))
      })
    } else if (signals.length > 0) {
      // No tasks, but show top signal as action
      const topSignal = signals[0]
      lines.push('-> NEXT (1)')
      lines.push(`Follow up: ${topSignal.name}`)
      lines.push(`Priority: ${topSignal.score}`)
    } else {
      // No tasks or signals
      lines.push('-> NEXT (0)')
      lines.push('All caught up!')
    }

    // Add remaining signals if space
    if (signals.length > 1 && lines.length < this.MAX_LINES) {
      const remaining = this.MAX_LINES - lines.length
      if (remaining >= 2) {
        lines.push('')
        lines.push(`OTHER SIGNALS (${signals.length - 1})`)
        signals.slice(1, Math.min(signals.length, 1 + remaining - 2)).forEach(s => {
          const name = s.name.split(' ')[0] // First name only
          lines.push(`• ${name} ${s.score}`)
        })
      }
    }

    // Ensure exactly 5 lines
    while (lines.length < this.MAX_LINES) {
      lines.push('')
    }

    return lines.slice(0, this.MAX_LINES).join('\n')
  }

  /**
   * Format stakeholder brief for G1 display
   */
  public static formatBrief(name: string, data: any): string {
    const lines: string[] = []
    
    lines.push(name.toUpperCase())
    lines.push(`Last: ${data.lastContact || 'Unknown'}`)
    lines.push(`Ball: ${data.ballInCourt || 'Unknown'}`)
    
    if (data.recentMessage) {
      lines.push(`"${this.truncate(data.recentMessage, 40)}"`)
    }
    
    if (data.nextAction) {
      lines.push(`-> ${this.truncate(data.nextAction, 40)}`)
    }

    return lines.slice(0, this.MAX_LINES).join('\n')
  }

  /**
   * Format any text for G1 display (generic)
   */
  public static formatGeneric(text: string): string {
    const lines = text.split('\n')
    const formatted: string[] = []

    for (const line of lines) {
      if (formatted.length >= this.MAX_LINES) break
      
      if (line.length <= this.MAX_CHARS_PER_LINE) {
        formatted.push(line)
      } else {
        // Wrap long lines
        const wrapped = this.wrapLine(line, this.MAX_CHARS_PER_LINE)
        formatted.push(...wrapped)
      }
    }

    return formatted.slice(0, this.MAX_LINES).join('\n')
  }

  /**
   * Truncate text to max length
   */
  private static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength - 3) + '...'
  }

  /**
   * Wrap a long line into multiple lines
   */
  private static wrapLine(text: string, maxLength: number): string[] {
    const words = text.split(' ')
    const lines: string[] = []
    let currentLine = ''

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= maxLength) {
        currentLine = (currentLine + ' ' + word).trim()
      } else {
        if (currentLine) lines.push(currentLine)
        currentLine = word
      }
    }

    if (currentLine) lines.push(currentLine)
    return lines
  }

  /**
   * Count how many lines text will take when displayed
   */
  public static countLines(text: string): number {
    const lines = text.split('\n')
    let totalLines = 0

    for (const line of lines) {
      if (line.length === 0) {
        totalLines += 1
      } else {
        totalLines += Math.ceil(line.length / this.MAX_CHARS_PER_LINE)
      }
    }

    return totalLines
  }

  /**
   * Format array of lines for G1 display
   */
  public static formatForG1(lines: string[]): string {
    return lines.slice(0, this.MAX_LINES).join('\n')
  }
}

export default DisplayFormatter
