export const TOUCH_GESTURES = [
  {gesture: 'single_tap', label: 'Single tap'},
  {gesture: 'double_tap', label: 'Double tap'},
  {gesture: 'triple_tap', label: 'Triple tap'},
  {gesture: 'long_press', label: 'Long press'},
  {gesture: 'forward_swipe', label: 'Forward swipe'},
  {gesture: 'backward_swipe', label: 'Backward swipe'},
  {gesture: 'up_swipe', label: 'Up swipe'},
  {gesture: 'down_swipe', label: 'Down swipe'},
] as const;

export type TouchGesture = (typeof TOUCH_GESTURES)[number]['gesture'];
export type TouchGestureDefaults = Record<TouchGesture, boolean>;

export function initialTouchGestureDefaults(): TouchGestureDefaults {
  return Object.fromEntries(TOUCH_GESTURES.map(({gesture}) => [gesture, true])) as TouchGestureDefaults;
}

// Keep the example buildable with the published SDK until this API ships.
// The optional method has the same signature as the new public SDK entry point.
type TouchGestureSdk = {
  setTouchGestureDefaultBehaviorEnabled?: (
    gesture: TouchGesture,
    enabled: boolean,
  ) => Promise<unknown>;
};

export async function applyTouchGestureDefault(
  sdk: TouchGestureSdk,
  gesture: TouchGesture,
  enabled: boolean,
): Promise<void> {
  if (typeof sdk.setTouchGestureDefaultBehaviorEnabled !== 'function') {
    throw new Error('Touchpad controls require an SDK build with touch gesture default behavior support.');
  }
  await sdk.setTouchGestureDefaultBehaviorEnabled(gesture, enabled);
}
