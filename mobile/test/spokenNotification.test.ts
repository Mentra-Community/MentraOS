/**
 * Spoken-notification shaping tests.
 *
 * The first version of this feature read the raw notification aloud, and on real
 * traffic it sounded like gibberish: URLs get spelled out character by
 * character, emoji and separators become nonsense syllables, and long bodies
 * turn a two-second announcement into a paragraph nobody can skip (OS-1821).
 *
 * These pin the shaping rules so a future change cannot quietly bring that back.
 */
import {
  buildSpokenNotification,
  sanitizeForSpeech,
  SPOKEN_MAX_CHARS,
  truncateOnWordBoundary,
} from "@/services/notifications/spokenNotification"

describe("sanitizeForSpeech", () => {
  test("strips URLs, the main source of spoken gibberish", () => {
    expect(sanitizeForSpeech("Check https://example.com/a?b=1 now")).toBe("Check now")
    expect(sanitizeForSpeech("see www.foo.com/x for details")).toBe("see for details")
    expect(sanitizeForSpeech("go to example.io/path now")).toBe("go to now")
  })

  test("strips emoji and decorative separators", () => {
    expect(sanitizeForSpeech("Deploy 🚀 done ✅")).toBe("Deploy done")
    expect(sanitizeForSpeech("Alice • Bob | Carol")).toBe("Alice Bob Carol")
  })

  test("collapses stuttering punctuation and whitespace", () => {
    expect(sanitizeForSpeech("Wait!!!  what???")).toBe("Wait! what?")
    expect(sanitizeForSpeech("a   b\n\nc")).toBe("a b c")
  })

  test("leaves ordinary prose untouched", () => {
    expect(sanitizeForSpeech("Standup moved to 10:30")).toBe("Standup moved to 10:30")
  })
})

describe("truncateOnWordBoundary", () => {
  test("never cuts a word in half", () => {
    // A mid-word cut is itself a source of "that sounded like nonsense".
    expect(truncateOnWordBoundary("alpha bravo charlie delta", 14)).toBe("alpha bravo")
  })

  test("prefers ending on a sentence when the sentence is most of the budget", () => {
    expect(truncateOnWordBoundary("This is a full sentence. And more text here", 30)).toBe("This is a full sentence.")
  })

  test("keeps the extra words when the sentence would throw away half the budget", () => {
    // Ending at "First thing." would discard 11 of the 22 available characters.
    // A word boundary is already safe to speak, so prefer the fuller version.
    expect(truncateOnWordBoundary("First thing. Second thing that runs on", 22)).toBe("First thing. Second")
  })

  test("leaves short text alone", () => {
    expect(truncateOnWordBoundary("short", 40)).toBe("short")
  })
})

describe("buildSpokenNotification", () => {
  test("leads with the app and title, which is what the wearer needs", () => {
    expect(buildSpokenNotification({app: "Slack", title: "Alex", content: "standup in 5"})).toBe(
      "Slack: Alex. standup in 5",
    )
  })

  test("drops group summaries that carry no content", () => {
    expect(buildSpokenNotification({app: "Gmail", title: "", content: "3 new messages"})).toBeNull()
    expect(buildSpokenNotification({app: "Slack", title: "2 messages", content: ""})).toBeNull()
  })

  test("stays silent for notifications the app marked as non-interrupting", () => {
    // Android PRIORITY_LOW / PRIORITY_MIN: speaking these is the one thing the
    // app explicitly asked us not to do.
    expect(buildSpokenNotification({app: "Sync", title: "Backup", content: "done", priority: -1})).toBeNull()
    expect(buildSpokenNotification({app: "Sync", title: "Backup", content: "done", priority: -2})).toBeNull()
    expect(buildSpokenNotification({app: "Sync", title: "Backup", content: "done", priority: 0})).not.toBeNull()
  })

  test("says nothing when sanitising leaves nothing to say", () => {
    // A link-only message: everything speakable was a URL.
    expect(buildSpokenNotification({app: "Feeds", title: "", content: "https://example.com/story"})).toBeNull()
  })

  test("caps length so a long body cannot become a monologue", () => {
    const body = "word ".repeat(200)
    const spoken = buildSpokenNotification({app: "Mail", title: "Digest", content: body})
    expect(spoken).not.toBeNull()
    expect(spoken!.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS)
    // And the cap must not slice a word apart.
    expect(spoken!.endsWith("word")).toBe(true)
  })

  test("does not repeat the app name when the title is the app name", () => {
    expect(buildSpokenNotification({app: "Signal", title: "Signal", content: "new message"})).toBe(
      "Signal. new message",
    )
  })

  test("sanitises before deciding, so a URL-laden notification still reads cleanly", () => {
    // The leftover "see" is deliberate. Dropping short bodies would also drop
    // legitimate ones — "Yes", "OK", "On my way" — so a stub word left behind by
    // a stripped URL is accepted as the lesser cost. What matters is that the
    // URL and emoji are gone, which is what made this unlistenable.
    expect(
      buildSpokenNotification({app: "CI", title: "Build failed 🔥", content: "see https://ci.example.com/42"}),
    ).toBe("CI: Build failed. see")
  })
})
