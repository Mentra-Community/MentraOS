/**
 * assertions.ts
 *
 * Custom assertions for testing DisplayManager.
 */

import { DisplayRequest, ActiveDisplay } from '@mentra/sdk';
import { strict as assert } from 'assert';

/**
 * Assert that two display requests have the same essential content
 */
export function assertDisplayMatch(
  actual: DisplayRequest | undefined | null,
  expected: DisplayRequest | undefined | null,
  message?: string
): void {
  // Handle null/undefined cases
  if (!actual && !expected) {
    return; // Both are null/undefined, so they match
  }

  if (!actual || !expected) {
    assert.fail(message || `Expected ${expected ? 'a display' : 'no display'} but got ${actual ? 'a display' : 'no display'}`);
  }

  // Compare packageName
  assert.equal(
    actual!.packageName,
    expected!.packageName,
    message || `Package name mismatch: ${actual!.packageName} !== ${expected!.packageName}`
  );

  // Compare layout type
  assert.equal(
    actual!.layout.layoutType,
    expected!.layout.layoutType,
    message || `Layout type mismatch: ${actual!.layout.layoutType} !== ${expected!.layout.layoutType}`
  );

  // Compare text content based on layout type
  if ('text' in actual!.layout && 'text' in expected!.layout) {
    assert.equal(
      actual!.layout.text,
      expected!.layout.text,
      message || `Text content mismatch: "${actual!.layout.text}" !== "${expected!.layout.text}"`
    );
  }

  if ('title' in actual!.layout && 'title' in expected!.layout) {
    assert.equal(
      actual!.layout.title,
      expected!.layout.title,
      message || `Title mismatch: "${actual!.layout.title}" !== "${expected!.layout.title}"`
    );
  }
}

/**
 * Assert that a display request contains specific text
 */
export function assertDisplayContainsText(
  display: DisplayRequest | ActiveDisplay | null | undefined,
  expectedText: string,
  message?: string
): void {
  // Handle null/undefined cases
  if (!display) {
    assert.fail(message || `Expected display containing "${expectedText}" but got no display`);
  }

  // Handle ActiveDisplay case
  const displayRequest = 'displayRequest' in display! ? display.displayRequest : display;

  // Get the text content based on layout type
  let actualText = '';

  if ('text' in displayRequest!.layout && displayRequest!.layout.text) {
    actualText = displayRequest!.layout.text;
  } else if ('message' in displayRequest!.layout && displayRequest!.layout.message) {
    actualText = displayRequest!.layout.message;
  } else if ('commands' in displayRequest!.layout && Array.isArray(displayRequest!.layout.commands)) {
    actualText = displayRequest!.layout.commands.join(' ');
  }

  // Check if expected text is contained
  assert.ok(
    actualText.includes(expectedText),
    message || `Expected display to contain "${expectedText}" but got "${actualText}"`
  );
}

/**
 * Assert that a display is from a specific package
 */
export function assertDisplayFromPackage(
  display: DisplayRequest | ActiveDisplay | null | undefined,
  expectedPackage: string,
  message?: string
): void {
  // Handle null/undefined cases
  if (!display) {
    assert.fail(message || `Expected display from package "${expectedPackage}" but got no display`);
  }

  // Handle ActiveDisplay case
  const displayRequest = 'displayRequest' in display! ? display.displayRequest : display;

  // Check package name
  assert.equal(
    displayRequest!.packageName,
    expectedPackage,
    message || `Expected display from package "${expectedPackage}" but got "${displayRequest!.packageName}"`
  );
}