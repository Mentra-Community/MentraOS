/**
 * Test: Prompt Builder — hasPhotos conditional vision section
 *
 * Tests that buildSystemPrompt() correctly includes/excludes vision sections
 * based on hasCamera and hasPhotos flags. No LLM calls — pure unit tests.
 *
 * Run: bun test src/visual/prompt-builder.test.ts
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, type AgentContext } from "../../../../agent/prompt";
import { ResponseMode } from "../../../../constants/config";

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    hasDisplay: false,
    hasSpeakers: true,
    hasCamera: true,
    hasPhotos: true,
    hasMicrophone: true,
    glassesType: "camera",
    responseMode: ResponseMode.QUICK,
    location: null,
    localTime: "3:00 PM",
    notifications: "No recent notifications.",
    conversationHistory: [],
    ...overrides,
  };
}

describe("buildSystemPrompt — vision section", () => {
  test("hasCamera=true, hasPhotos=true → includes full vision section", () => {
    const prompt = buildSystemPrompt(makeContext({ hasCamera: true, hasPhotos: true }));
    expect(prompt).toContain("I always receive a photo from the smart glasses camera");
    expect(prompt).toContain("STEP 1 — CLASSIFY THE QUERY");
    expect(prompt).not.toContain("NO photo was captured");
  });

  test("hasCamera=true, hasPhotos=false → includes vision failed section", () => {
    const prompt = buildSystemPrompt(makeContext({ hasCamera: true, hasPhotos: false }));
    expect(prompt).toContain("NO photo was captured for this query");
    expect(prompt).toContain("Do NOT reference, describe, or mention any image");
    expect(prompt).not.toContain("I always receive a photo");
  });

  test("hasCamera=false → no vision section at all", () => {
    const prompt = buildSystemPrompt(makeContext({
      hasCamera: false,
      hasPhotos: false,
      hasDisplay: true,
      hasSpeakers: false,
      glassesType: "display",
    }));
    expect(prompt).not.toContain("Vision (Camera)");
    expect(prompt).not.toContain("I always receive a photo");
    expect(prompt).not.toContain("NO photo was captured");
  });

  test("hasCamera=false, hasPhotos=true → still no vision section (impossible state but safe)", () => {
    const prompt = buildSystemPrompt(makeContext({
      hasCamera: false,
      hasPhotos: true,
      hasDisplay: true,
      hasSpeakers: false,
      glassesType: "display",
    }));
    expect(prompt).not.toContain("Vision (Camera)");
  });
});

describe("buildSystemPrompt — camera capabilities text", () => {
  test("camera glasses → capabilities mention camera", () => {
    const prompt = buildSystemPrompt(makeContext({ hasCamera: true }));
    expect(prompt).toContain("Camera");
    expect(prompt).not.toContain("NO camera");
  });

  test("display glasses → capabilities mention NO camera", () => {
    const prompt = buildSystemPrompt(makeContext({
      hasCamera: false,
      hasDisplay: true,
      hasSpeakers: false,
      glassesType: "display",
      hasPhotos: false,
    }));
    expect(prompt).toContain("NO camera");
  });
});
