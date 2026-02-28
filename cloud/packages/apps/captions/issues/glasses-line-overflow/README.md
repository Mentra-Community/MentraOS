# Glasses Line Overflow Bug

When text lines are too long, the glasses wrap them internally, causing lines to overflow beyond the visible display area and making transcriptions appear broken.

## Documents

- **overflow-spec.md** - Technical analysis and implementation plan

## Problem

The TranscriptProcessor formats text for N lines with M characters per line. However, the glasses have their own internal text wrapping:

1. **Processor sends 5 lines** (fitting within maxLines)
2. **Glasses receive a line that's too long** for the physical display width
3. **Glasses wrap that line** internally → now 6 rendered lines
4. **Glasses can only show 5 lines** → the 6th line is hidden
5. **User sees text disappear** → feels like transcription is broken

## Real-World Testing Results

- **Latin text**: 44 characters is the safe maximum (over 44 wraps)
- **Hanzi text**: ~18-22 characters depending on content
- **Mixed Chinese + English**: Even with conservative 14-char limit, **still wraps**

The `isHanzi` per-session flag cannot solve mixed content because it applies a fixed limit regardless of actual character mix in each line.

## Visual Example

**What processor sends (5 lines, 52 chars each):**
```
said. 中国古老一句话，天下无难事，只怕有心人。你有没有那个心?
我觉得这是第一个要执着。 Now I'm going to explain it
sentence by sentence. 好，锅台明送给年轻人的成功三秘诀。
锅台明，这个就是他的名字，他叫锅台明。他送给，送给，送给就是 give，送给
example, I can say
```

**What glasses actually render (6+ lines due to overflow):**
```
said. 中国古老一句话，天下无难事，只怕有心
人。你有没有那个心?                        ← wrapped
我觉得这是第一个要执着。 Now I'm going to 
explain it                                 ← wrapped
sentence by sentence. 好，锅台明送给年轻人的
成功三秘诀。                               ← hidden!
```

The last line(s) get pushed off the visible area.

## Root Cause

### Character Width Mismatch

The TranscriptProcessor uses **character count** to determine line length, but:

1. **Chinese characters are ~2x wider** than Latin characters on the display
2. **Mixed content** (Chinese + English) has variable widths per character
3. **Per-session `isHanzi` flag** cannot handle mixed content lines

### The Math Problem

If max visual width = 44 units (tested safe for Latin):
- 44 Latin chars = 44 units ✓
- 22 Chinese chars = 44 units ✓
- Mixed "他送给 give 送给 example" = unpredictable!

The processor applies a fixed character limit but actual visual width varies per character.

## Chosen Solution: Visual Width Calculation

Calculate visual width **per-character** instead of using fixed character counts:

```typescript
function getCharWidth(char: string): number {
  if (isCJKCharacter(char)) return 2.0  // Chinese, Japanese, Korean
  return 1.0  // Latin, numbers, punctuation
}
```

This automatically handles:
- Pure Latin: ~44 chars per line
- Pure CJK: ~22 chars per line  
- Mixed content: Variable, calculated dynamically
- **Maximizes characters per line** while never overflowing

## Status

- [x] Bug identified
- [x] Real-world testing completed (44 Latin, mixed still wraps)
- [x] Root cause confirmed (per-session flag can't handle mixed content)
- [x] Solution chosen (visual width per-character)
- [x] Implement visual width utilities (`visualWidth.ts`)
- [x] Update TranscriptProcessor to use visual width
- [ ] Test with Chinese, Japanese, Korean, mixed content on real glasses

## Priority

**HIGH** - Chinese/Japanese users see broken transcriptions, text disappears mid-conversation.