import {describe, expect, test} from 'bun:test';
import {applyTouchGestureDefault, initialTouchGestureDefaults, TOUCH_GESTURES} from './touchGestureDefaults';

describe('touchpad default controls', () => {
  test('every gesture starts enabled and gets its own SDK request', async () => {
    const defaults = initialTouchGestureDefaults();
    const calls: Array<[string, boolean]> = [];
    const sdk = {async setTouchGestureDefaultBehaviorEnabled(gesture: string, enabled: boolean) {
      calls.push([gesture, enabled]);
      return {status: 'applied' as const, request_id: 'test'};
    }};
    for (const {gesture} of TOUCH_GESTURES) {
      expect(defaults[gesture]).toBe(true);
      await applyTouchGestureDefault(sdk, gesture, false);
      await applyTouchGestureDefault(sdk, gesture, true);
    }
    expect(calls).toEqual(TOUCH_GESTURES.flatMap(({gesture}) => [[gesture, false], [gesture, true]]));
  });
  test('published SDK without the method fails clearly', async () => {
    await expect(applyTouchGestureDefault({}, 'double_tap', false)).rejects.toThrow('require an SDK build');
  });
  test('firmware rejection propagates', async () => {
    const sdk = {async setTouchGestureDefaultBehaviorEnabled() {throw new Error('firmware timeout');}};
    await expect(applyTouchGestureDefault(sdk, 'double_tap', false)).rejects.toThrow('firmware timeout');
  });
});
