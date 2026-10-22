import { createContext, useContext } from 'react';

const TAB_BAR_SCROLL_PADDING = 140;
const KEYBOARD_SCROLL_PADDING = 24;

export const KeyboardVisibleContext = createContext(false);

export function useKeyboardVisible() {
  return useContext(KeyboardVisibleContext);
}

export function useScrollBottomPadding() {
  return useKeyboardVisible() ? KEYBOARD_SCROLL_PADDING : TAB_BAR_SCROLL_PADDING;
}
