// src/enums.ts

/**
 * Types of Third-Party Applications (Apps)
 */
export enum AppType {
  SYSTEM_DASHBOARD = "system_dashboard", // Special UI placement, system functionality
  BACKGROUND = "background", // Can temporarily take control of display
  STANDARD = "standard", // Regular App (default) only one standard app can run at a time. starting a standard App will close any other standard App that is running.
}

/**
 * Types of layouts for displaying content
 */
export enum LayoutType {
  TEXT_WALL = "text_wall",
  DOUBLE_TEXT_WALL = "double_text_wall",
  DASHBOARD_CARD = "dashboard_card",
  REFERENCE_CARD = "reference_card",
  BITMAP_VIEW = "bitmap_view",
  BITMAP_ANIMATION = "bitmap_animation",
  CLEAR_VIEW = "clear_view",
}

/**
 * Types of views for displaying content
 */
export enum ViewType {
  DASHBOARD = "dashboard", // Regular dashboard (main/expanded)
  // ALWAYS_ON = "always_on", // Persistent overlay dashboard
  MAIN = "main", // Regular app content
}

// Types for AppSettings
export enum AppSettingType {
  TOGGLE = "toggle",
  TEXT = "text",
  SELECT = "select",
  SLIDER = "slider",
  GROUP = "group",
  TEXT_NO_SAVE_BUTTON = "text_no_save_button",
  SELECT_WITH_SEARCH = "select_with_search",
  MULTISELECT = "multiselect",
  TITLE_VALUE = "titleValue",
  NUMERIC_INPUT = "numeric_input",
  TIME_PICKER = "time_picker",
}
// | { type: "toggle"; key: string; label: string; defaultValue: boolean }
// | { type: "text"; key: string; label: string; defaultValue?: string }
// | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; defaultValue?: string };

/**
 * Types of hardware components that apps can require
 */
export enum HardwareType {
  CAMERA = "CAMERA",
  DISPLAY = "DISPLAY",
  MICROPHONE = "MICROPHONE",
  SPEAKER = "SPEAKER",
  IMU = "IMU",
  BUTTON = "BUTTON",
  LIGHT = "LIGHT",
  WIFI = "WIFI",
}

/**
 * Levels of hardware requirements
 */
export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED", // App cannot function without this hardware
  OPTIONAL = "OPTIONAL", // App has enhanced features with this hardware
}
