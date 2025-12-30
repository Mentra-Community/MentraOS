# Zombie Stream Bug - INVESTIGATION CLOSED

**Status**: ❌ Hypothesis Disproven - Was User Silence

## Original Hypothesis

Suspected that Soniox WebSocket streams were dying silently - stopping transcription while the connection remained open, creating "zombie" streams that we continued to send audio into.

## Evidence That Appeared to Support This

- `transcriptEndMs` appeared frozen at 3,997,920 ms for 60+ minutes
- `processingDeficitMs` grew linearly (~60s per minute)
- `audioSentBytes` kept increasing (audio was being sent)
- No error logs from Soniox

## What Actually Happened

**The user was simply silent for ~60 minutes.**

### Key Evidence

When we searched for intermediate `transcriptEndMs` values between 3,997,920 ms and 7,701,360 ms:

```sql
SELECT DISTINCT transcriptEndMs 
WHERE transcriptEndMs > 3997920 AND transcriptEndMs < 7701360
```

**Result: NO intermediate values found.**

If Soniox had been processing a backlog, we would have seen gradual progression through intermediate values (4M, 5M, 6M, 7M, etc.). Instead, the value JUMPED directly from 3,997,920 to 7,701,360.

### Timeline Reconstruction

| Time | transcriptEndMs | What Was Happening |
|------|-----------------|-------------------|
| Earlier | 3,997,920 ms (~66 min) | User was speaking, transcription active |
| 22:12-22:26 | 3,997,920 ms (frozen) | User went SILENT - no speech to transcribe |
| 22:27 | 7,701,360 ms (~128 min) | User started speaking again |
| 22:28 | 7,714,320 ms | Healthy real-time transcription resumed |

### How Soniox Works

Per Soniox documentation:
- Soniox only sends tokens when **speech is detected**
- The `end_ms` timestamp represents the position of the **last speech token**
- During silence, no tokens are sent, so `transcriptEndMs` doesn't advance
- This is correct behavior, not a bug

## Why the Metric Was Misleading

The `processingDeficitMs` calculation:

```
processingDeficitMs = audioSentDurationMs - transcriptEndMs
```

During silence:
- `audioSentDurationMs` keeps growing (we continue sending audio)
- `transcriptEndMs` stays frozen (no speech = no transcript updates)
- Deficit appears HUGE even though Soniox is working correctly!

## The REAL Issue Discovered

**Why is audio being sent during 60+ minutes of silence?**

If VAD (Voice Activity Detection) is working correctly:
1. VAD should detect silence
2. Transcription streams should close (`cleanupIdleStreams`)
3. No audio should be sent to Soniox during silence

But we observed:
- Audio was sent at real-time rate (~60s of audio per minute) during the entire "frozen" period
- Streams remained open throughout

This suggests:
1. VAD is not properly closing streams during silence, OR
2. Audio is being sent regardless of VAD state, OR
3. VAD threshold is too sensitive (detecting background noise as speech)

## Conclusions

1. **NOT a zombie stream bug** - Soniox was working correctly
2. **NOT a backlog recovery** - There was no backlog, just silence
3. **The deficit metric is misleading** - It looks like lag but is actually silence
4. **Potential VAD/stream lifecycle issue** - Audio shouldn't be sent during extended silence

## Recommendations

1. **Investigate VAD behavior** - Why are streams and audio continuing during 60+ minute silence periods?
2. **Improve metrics** - Add "time since last token received" to distinguish silence from actual issues
3. **Consider stream lifecycle** - Should streams auto-close after extended silence?
4. **Cost consideration** - Sending silent audio to Soniox wastes API credits

## Lessons Learned

1. "Frozen" transcript position doesn't mean dead stream - could be silence
2. Verify hypotheses by checking for intermediate values before assuming gradual processes
3. Understand how third-party APIs (Soniox) behave during edge cases (silence)
4. Large metric values can be misleading - always investigate the underlying cause

## See Also

- Parent issue: `../README.md`
- Original (incorrect) spec: `zombie-stream-spec.md` (kept for historical reference)