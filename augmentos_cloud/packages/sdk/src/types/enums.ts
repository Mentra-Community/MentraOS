// src/enums.ts

/**
 * Types of Third-Party Applications (TPAs)
 */
export enum TpaType {
    SYSTEM_DASHBOARD = 'system_dashboard',  // Special UI placement, system functionality
    BACKGROUND = 'background',              // Can temporarily take control of display
    STANDARD = 'standard'                   // Regular TPA (default) only one standard app can run at a time. starting a standard TPA will close any other standard TPA that is running.
}

/**
 * Application states in the system
 */
export enum AppState {
    NOT_INSTALLED = 'not_installed',  // Initial state
    INSTALLED = 'installed',          // Installed but never run
    BOOTING = 'booting',              // Starting up
    RUNNING = 'running',              // Active and running
    STOPPED = 'stopped',              // Manually stopped
    ERROR = 'error'                   // Error state
}

/**
 * Supported languages
 */
export enum Language {
    EN = "en",
    ES = "es",
    FR = "fr",
    // TODO: Add more languages
}

/**
 * Types of layouts for displaying content
 */
export enum LayoutType {
    TEXT_WALL = 'text_wall',
    DOUBLE_TEXT_WALL = 'double_text_wall',
    DASHBOARD_CARD = 'dashboard_card',
    REFERENCE_CARD = 'reference_card',
    BITMAP_VIEW = 'bitmap_view'
}

/**
 * Types of views for displaying content
 */
export enum ViewType {
    DASHBOARD = 'dashboard',   // Regular dashboard (main/expanded)
    ALWAYS_ON = 'always_on',   // Persistent overlay dashboard
    MAIN = 'main'              // Regular app content
}

// Types for AppSettings
export enum AppSettingType {
    TOGGLE = 'toggle',
    TEXT = 'text',
    SELECT = 'select'
}
// | { type: "toggle"; key: string; label: string; defaultValue: boolean }
// | { type: "text"; key: string; label: string; defaultValue?: string }
// | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; defaultValue?: string };