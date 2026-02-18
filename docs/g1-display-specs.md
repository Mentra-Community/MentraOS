# G1 Display Specifications

## Hardware Testing Results

**Date:** 2026-02-17  
**Device:** Even Realities G1  
**Test Method:** LocalMiniApp with custom HTML sending text via `mantle.displayTextMain()`

## Display Constraints

### Line Capacity
- **Maximum visible lines:** 5 lines
- **Line wrapping:** Automatic at word boundaries
- **Characters per line:** ~40-50 characters (varies by character width)

### Character Support
- ✅ **ASCII characters:** Full support
- ✅ **Arrows:** `→` renders correctly
- ✅ **Bullets:** `•` renders correctly
- ✅ **Emojis:** `📧` renders correctly (tested with mail emoji)
- ⚠️ **Unicode:** Limited testing, but common symbols work

### Text Behavior
- **Overflow:** Text beyond 5 lines is cut off (not scrollable by default)
- **Wrapping:** Long lines wrap automatically
- **Whitespace:** Preserved (newlines work as expected)
- **Formatting:** Plain text only (no bold, italic, colors)

## Test Results

### Test 1: Short Text
**Input:**
```
Hello G1!
```

**Result:** ✅ Displays perfectly

---

### Test 2: Long Text
**Input:**
```
This is a longer text to test how the G1 handles
multiple lines and wrapping. Let's see how it
displays this content across the screen.

Line 1
Line 2
Line 3
Line 4
Line 5
```

**Result:** ⚠️ Cuts off after "Line 1" (approximately 5 lines visible)

---

### Test 3: Formatted Dashboard
**Input:**
```
→ NEXT ACTIONS (3)
• Follow up: Alice (98%)
• Review: Proposal (95%)
• Schedule: Meeting (90%)

Ball in Court
Me: 5  |  Them: 12

📧 3 unread messages
```

**Result:** ⚠️ Shows only first 5 lines:
```
→ NEXT ACTIONS (3)
• Follow up: Alice (98%)
• Review: Proposal (95%)
• Schedule: Meeting (90%)
```

Everything after line 4 is cut off.

---

## Optimal Display Formats

### Dashboard Format (5 lines)

**Option A: Task-focused**
```
→ NEXT (3)
• Alice (98%)
• Proposal (95%)
• Meeting (90%)
Ball: Me 5 | Them 12
```

**Option B: Balanced**
```
→ NEXT (3)
• Alice 98%
• Proposal 95%
• Meeting 90%
📧 3 unread
```

**Option C: Ultra-compact**
```
→ NEXT (3)
• Alice 98% | Proposal 95%
• Meeting 90%
Ball: 5/12 | 📧 3
```

---

### Stakeholder Brief Format (5 lines)

```
ALICE JOHNSON
Last: 2d | Ball: Them
📧 "Are we still on..."
📅 Tomorrow 3pm
→ Follow up proposal
```

---

### Message View Format (5 lines)

```
ALICE (2h ago)
Are we still on for
tomorrow?

ME (1h ago)
Yes, 3pm works
```

---

### Calendar Format (5 lines)

```
TODAY
3:00 PM Meeting: Bob
5:00 PM Call: Carol

TOMORROW
9:00 AM Standup
```

---

## Design Guidelines

### 1. Prioritize Information
- **Most important first** - User sees top 5 lines only
- **Progressive disclosure** - Can send multiple screens if needed
- **Context matters** - Show what's relevant now

### 2. Use Symbols Effectively
- `→` for actions/next steps
- `•` for list items
- `📧` for messages
- `📅` for calendar events
- `⏰` for time-sensitive items
- `✓` for completed items

### 3. Abbreviate Intelligently
- "NEXT ACTIONS" → "NEXT"
- "Ball in Court" → "Ball"
- "Follow up with" → "Follow up"
- "98% complete" → "98%"
- "2 days ago" → "2d"

### 4. Optimize Line Usage
- **Line 1:** Title/Context
- **Lines 2-4:** Primary content
- **Line 5:** Secondary info or call-to-action

### 5. Handle Overflow
- **Truncate gracefully** - End with "..." if needed
- **Paginate** - Send multiple screens for long content
- **Summarize** - Show counts instead of full lists

---

## Implementation Recommendations

### Display Formatter Function

```typescript
interface DisplayOptions {
  maxLines: number        // Default: 5
  maxCharsPerLine: number // Default: 45
  truncateIndicator: string // Default: "..."
}

function formatForG1(data: any, type: DisplayType, options?: DisplayOptions): string {
  // Format data to fit G1 constraints
  // Return string with max 5 lines
}
```

### Line Counting

```typescript
function countLines(text: string, maxCharsPerLine: number = 45): number {
  const lines = text.split('\n')
  let totalLines = 0
  
  for (const line of lines) {
    if (line.length === 0) {
      totalLines += 1
    } else {
      totalLines += Math.ceil(line.length / maxCharsPerLine)
    }
  }
  
  return totalLines
}
```

### Truncation

```typescript
function truncateToLines(text: string, maxLines: number = 5): string {
  const lines = text.split('\n')
  
  if (lines.length <= maxLines) {
    return text
  }
  
  return lines.slice(0, maxLines - 1).join('\n') + '\n...'
}
```

---

## Testing Checklist

- [x] Short text (< 1 line)
- [x] Long text (> 5 lines)
- [x] Formatted text with symbols
- [x] Line wrapping behavior
- [x] Symbol rendering (→, •, 📧)
- [ ] Emoji rendering (other emojis)
- [ ] Special characters (©, ®, ™, etc.)
- [ ] Non-English characters (é, ñ, ü, etc.)
- [ ] Very long words (URL-like strings)
- [ ] Mixed content (text + numbers + symbols)

---

## Known Limitations

1. **No scrolling** - Only first 5 lines visible
2. **No formatting** - Plain text only (no bold, colors, etc.)
3. **No interaction** - Display only, no touch/click
4. **Fixed font** - Cannot change font size or style
5. **Monospace assumption** - Character width varies, ~45 chars/line is estimate

---

## Future Enhancements

### Scrolling Support
If G1 supports scrolling (needs investigation):
- Send longer content
- Add scroll indicators ("↓ More")
- Paginate automatically

### Interactive Elements
If G1 supports interaction (needs investigation):
- Clickable items
- Navigation between screens
- Voice command integration

### Dynamic Updates
- Real-time content updates
- Animations/transitions
- Progress indicators

---

## References

- Test HTML: `/mobile/lma_example/g1-test.html`
- MiniComms: `/mobile/src/services/MiniComms.ts`
- LocalMiniApp: `/mobile/src/components/home/LocalMiniApp.tsx`
- Display method: `mantle.displayTextMain(text: string)`
