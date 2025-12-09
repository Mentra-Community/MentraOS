import {getAllColors} from "./colorTools"

const palette = {
  neutral900: "#fffaf0",
  neutral800: "#F4F2F1",
  neutral700: "#D7CEC9",
  neutral600: "#F5F5F5",
  neutral500: "#978F8A",
  neutral400: "#564E4A",
  neutral300: "#3C3836",
  neutral200: "#222222",
  neutral100: "#000000",

  // Primary
  primary900: "#F4E0D9",
  primary800: "#E6D0E0",
  primary700: "#D8C0E7",
  primary600: "#C4B0EE",
  primary500: "#00B869",
  primary400: "#8070DE",
  primary300: "#6054D6",
  primary200: "#4040CE",
  primary100: "#2030C6",

  // Secondary
  secondary900: "#F0F0F5",
  secondary800: "#E6E7F0",
  secondary700: "#DCDDE9",
  secondary600: "#CCD0E0",
  secondary500: "#BCC0D6",
  secondary400: "#A6ABCC",
  secondary300: "#9196B9",
  secondary200: "#626894",
  secondary100: "#41476E",

  // Accent
  accent900: "#FFF8F0",
  accent800: "#FFF4E6",
  accent700: "#FFEED4",
  accent600: "#FFE6C2",
  accent500: "#FFDEB0",
  accent400: "#FFD49E",
  accent300: "#FFCA8C",
  accent200: "#FFC07A",
  accent100: "#FFB668",

  // Angry/Error
  angry100: "#F2D6CD",
  angry500: "#C03403",
  angry600: "#FC7DE3",

  // Success
  success500: "#22C55E",
  success100: "#4CAF50",

  // Pure colors
  black: "#000000",
  white: "#FFFFFF",
  transparent: "rgba(0, 0, 0, 0)",

  // Additional unique colors
  blueTintedWhite: "#F8FAFF",
  purpleBlue1: "#4340D3",
  purpleBlue2: "#06114D",
  purpleBlue3: "#4240D1",
  purpleBlue4: "#3230A4",
  purpleBlue5: "#2B29B4",
  purpleBlue6: "#312FB4",
  purpleBlue7: "#7674FB",
  mediumBlue: "#4A90E2",
  lightPurple1: "#E7E7FF",
  purpleGray1: "#565E8C",
  purpleGray2: "#4F5474",
  purpleGray3: "#898FB2",
  darkText1: "#030514",
  darkText2: "#333333",
  warningPink: "rgba(254, 152, 235, 0.2)",
  warningPinkStrong: "rgba(254, 152, 235, 0.4)",
  warningPinkBorder: "rgba(254, 152, 235, 0.16)",

  // special:
  tagBackground: "rgba(66, 64, 209, 0.1)",
} as const

const unique = {
  backgroundStart: palette.neutral900,
  backgroundEnd: palette.neutral800,

  // Switch/toggle states
  switchTrackOff: palette.lightPurple1,
  switchTrackOn: palette.purpleBlue7,
  switchThumb: palette.neutral900,
  switchThumbOn: palette.neutral900,
  switchThumbOff: palette.neutral900,
  switchBorder: palette.purpleBlue3,

  // Slider states
  sliderThumb: palette.neutral300,
  sliderTrackActive: palette.primary500,
  sliderTrackInactive: palette.neutral700,
} as const

const design = {
  ...getAllColors("light mode"),
}

export const colors = {
  palette,

  // Text colors
  text: palette.neutral100,
  textDim: palette.neutral300,
  textAlt: palette.neutral800,

  // Backgrounds
  // background: palette.white,
  backgroundAlt: palette.neutral600,
  backgroundNeo: palette.neutral900,
  modalOverlay: "rgba(0, 0, 0, 0.7)",

  // Borders
  // border: palette.neutral700,

  // Primary colors
  tint: palette.primary500,
  tintInactive: palette.neutral700,
  buttonIconBackground: palette.neutral700, // Icon pill buttons - same as tintInactive for light theme
  separator: palette.neutral700,

  // Error states
  error: palette.angry500,
  errorBackground: palette.angry100,
  success: palette.success500,
  warning: palette.accent300,

  // Common:
  // primary: palette.primary500,
  // secondary: palette.secondary600,
  // accent: palette.accent500,

  // Iconography
  icon: palette.neutral100,
  iconSecondary: palette.neutral300,

  // Status chips
  statusIcon: palette.secondary200,
  statusText: palette.neutral100,

  ...unique,

  ...design,

  // defined here so auto-complete works:
  primary: design.primary,
  primary_foreground: design.primary_foreground,

  ring: design.ring,

  input: design.input,
  border: design.border,

  secondary: design.secondary,
  secondary_foreground: design.secondary_foreground,

  muted: design.muted,
  muted_foreground: design.muted_foreground,

  accent: design.accent,
  accent_foreground: design.accent_foreground,

  destructive: design.destructive,
  destructive_foreground: design.destructive_foreground,

  background: design.background,
  foreground: design.foreground,

  card: design.card,
  card_foreground: design.card_foreground,

  popover: design.popover,
  popover_foreground: design.popover_foreground,

  chart_1: design.chart_1,
  chart_2: design.chart_2,
  chart_3: design.chart_3,
  chart_4: design.chart_4,
  chart_5: design.chart_5,

  sidebar: design.sidebar,
  sidebar_foreground: design.sidebar_foreground,

  sidebar_primary: design.sidebar_primary,
  sidebar_primary_foreground: design.sidebar_primary_foreground,

  sidebar_accent: design.sidebar_accent,
  sidebar_accent_foreground: design.sidebar_accent_foreground,

  sidebar_border: design.sidebar_border,
  sidebar_ring: design.sidebar_ring,
  background_color: design.background_color,
} as const
