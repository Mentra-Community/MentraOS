/**
 * A DOM for the package's interaction tests, on happy-dom (the house choice, as in the Miniapp SDK's
 * tests). Call `setupDom()` in `beforeAll` and `teardownDom()` in `afterAll`; the globals are restored after, so
 * the server-render suites that share the process never see a `window`.
 *
 * happy-dom is a DOM, not a browser: it has no implicit activation, so Enter or Space on a button, a link or a
 * checkbox does nothing by itself, and its `<dialog>` only toggles `open`. `press` therefore finishes what a
 * browser would do for the keys a native control owns (it clicks), after giving the page's own handlers the
 * chance to cancel. Everything a component handles itself (arrows, Escape, Tab) goes through unchanged.
 *
 * Tests only: exported as `@mentra/workspace-ui/test-dom` for the portal's tests, never from the package's root,
 * and a browser build that imports it fails on `bun:test`.
 */

import { jest } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";

let createRoot: typeof import("react-dom/client").createRoot;
const mounted = new Set<{ root: Root; container: HTMLElement }>();

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };

export async function setupDom(): Promise<void> {
  GlobalRegistrator.register({ url: "https://portal.example.test/" });
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  // After the globals exist: react-dom reads them when it first loads.
  ({ createRoot } = await import("react-dom/client"));
}

export async function teardownDom(): Promise<void> {
  await cleanup();
  delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
}

/**
 * One turn of the timer queue, which is what lets a timer-scheduled update (the query cache's notify timer, a
 * zero-delay `setTimeout`) run before the caller carries on.
 *
 * Under `jest.useFakeTimers()` a real timeout never fires, so waiting on one would hang the test for good, and
 * the clock belongs to the test: Bun moves it a millisecond even for `advanceTimersByTime(0)`, which would eat
 * into a deadline the test is counting down to ("one millisecond before the minute is up"). So there the turn
 * leaves the clock alone and yields once to the event loop (`setImmediate`, which Bun doesn't fake), enough for
 * promises and React's own scheduling to run. A timer the test wants fired, it advances to itself.
 */
function turn(): Promise<void> {
  if (jest.isFakeTimers()) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Lets work that is still on its way land inside `act`: a request that answered, the query cache's notify timer,
 * the render it asks for. A screen that fetches would otherwise have its last update arrive after the test's own
 * `act` scope, in the middle of the next test, and React says so ("not wrapped in act(...)"). A few turns of the
 * timer queue is enough: each one runs what the one before it scheduled.
 */
export async function flush(turns = 4): Promise<void> {
  for (let done = 0; done < turns; done++) {
    await act(async () => {
      await turn();
    });
  }
}

/**
 * Waits, inside `act`, until `check()` holds (a request answered, a render it asked for), then lets what that
 * caused land too (see `flush`), so nothing is left to arrive after the test has moved on. Throws when it doesn't
 * hold in time, naming `what` it waited for.
 */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (check()) {
      await flush(2);
      return;
    }
    await act(async () => {
      // Under fake timers the test owns the clock: there is nothing to wait out here, only a turn to give.
      await (jest.isFakeTimers() ? turn() : new Promise((resolve) => setTimeout(resolve, 5)));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Unmounts everything `render` mounted and empties the page, after letting pending work land (see `flush`). */
export async function cleanup(): Promise<void> {
  if (mounted.size > 0) await flush();
  for (const entry of mounted) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  mounted.clear();
  document.body.innerHTML = "";
}

export interface Mounted {
  container: HTMLElement;
  rerender(ui: ReactElement): Promise<void>;
}

/**
 * Runs `action` inside `act`, then lets what it set going land (see `flush`). React renders an action's updates as
 * its `act` scope closes, and an effect that then runs may touch the query cache, which tells its observers from
 * a timer: that update would reach a component after the scope was over, and React would say it was "not wrapped
 * in act(...)". Every helper below goes through this.
 */
async function inAct(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action();
  });
  await flush(2);
}

/** Mounts `ui` in the page and lets React settle. */
export async function render(ui: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.add({ root, container });
  await inAct(() => root.render(ui));
  return { container, rerender: (next) => inAct(() => root.render(next)) };
}

/**
 * Whether an alert is drawn in the neutral notice style (the grey surface), not in the amber that marks a failed or
 * incomplete payment and over-assignment, and nothing else, on the Licenses, Members and Billing screens.
 */
export function isNeutral(element: Element): boolean {
  return element.className.includes("bg-surface") && !element.className.includes("bg-error");
}

/** `document.querySelector`, throwing when it finds nothing, so a test fails where it looked. */
export function find<T extends Element = HTMLElement>(selector: string, within: ParentNode = document): T {
  const found = within.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

export function findAll<T extends Element = HTMLElement>(selector: string, within: ParentNode = document): T[] {
  return [...within.querySelectorAll<T>(selector)];
}

/** The element with this text, among `selector`'s (a button's label, a menu item's). */
export function byText<T extends HTMLElement = HTMLElement>(text: string, selector = "*", within: ParentNode = document): T {
  const found = findAll<T>(selector, within).find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`no ${selector} with the text "${text}"`);
  return found;
}

export async function click(element: Element): Promise<void> {
  await inAct(() => {
    (element as HTMLElement).click();
  });
}

export async function focus(element: HTMLElement): Promise<void> {
  await inAct(() => element.focus());
}

/** A pointer press on `target`, which is what `useDismiss` listens for. */
export async function pointerDown(target: Element = document.body): Promise<void> {
  await inAct(() => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  });
}

/** Typing into a text field the way a person does: the value changes, then `input` fires. */
export async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await inAct(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Presses `key` on `element`: keydown (cancelable, bubbling), then what the platform does for a native control
 * when nothing cancelled it. Enter clicks a button or a link; Space clicks a button or toggles a checkbox, on
 * release. Returns whether a page handler cancelled the keydown.
 */
export async function press(element: HTMLElement, key: string, init: { shift?: boolean } = {}): Promise<boolean> {
  let cancelled = false;
  await inAct(() => {
    const down = new KeyboardEvent("keydown", { key, shiftKey: init.shift ?? false, bubbles: true, cancelable: true });
    element.dispatchEvent(down);
    cancelled = down.defaultPrevented;
    if (!cancelled) {
      const tag = element.tagName;
      const isCheckbox = tag === "INPUT" && (element as HTMLInputElement).type === "checkbox";
      if (key === "Enter" && (tag === "BUTTON" || tag === "A")) element.click();
      if (key === " " && (tag === "BUTTON" || isCheckbox)) element.click();
    }
    element.dispatchEvent(new KeyboardEvent("keyup", { key, shiftKey: init.shift ?? false, bubbles: true, cancelable: true }));
  });
  return cancelled;
}

export const activeElement = () => document.activeElement as HTMLElement | null;
