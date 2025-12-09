import {getAllColors} from "./colorTools"

const palette = {
  // Neutrals
  neutral900: "#FFFFFF",
  neutral800: "#F4F2F1",
  neutral700: "#D7CEC9",
  neutral600: "#B6ACA6",
  neutral500: "#978F8A",
  neutral400: "#564E4A",
  neutral300: "#3C3836",
  neutral200: "#222222",
  neutral100: "#171717",

  // Primary
  primary900: "#D8C0E7",
  primary800: "#C4B0EE",
  primary700: "#B0B9FF",
  primary600: "#A090E6",
  primary500: "#36DD88",
  primary400: "#6054D6",
  primary300: "#4040CE",
  primary200: "#202761",
  primary100: "#161C47",

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
  angry600: "#FE98EB",

  // Success
  success500: "#E8F5E8",
  success100: "#4CAF50",

  // Pure colors
  black: "#000000",
  white: "#FFFFFF",
  transparent: "rgba(0, 0, 0, 0)",

  // Additional unique colors
  darkBlue1: "#090A14",
  darkBlue2: "#080D33",
  darkBlue3: "#030514",
  darkBlue4: "#1D1D45",
  darkBlue5: "#0F1861",
  purpleBlue1: "#4340D3",
  purpleBlue2: "#06114D",
  purpleBlue3: "#7B79FF",
  purpleBlue4: "#7674FB",
  purpleGray1: "#565E8C",
  purpleGray2: "#747CAB",
  purpleGray3: "#898FB2",
  lightPurple1: "#D5D8F5",
  lightPurple2: "#ABAAFF",
  darkPurple1: "#474794",
  darkPurple2: "#141434",
  lightText: "#F9F8FE",
  darkGray: "#121212",
  modalDark: "#1c1c1c",
  warningPink: "rgba(254, 152, 235, 0.2)",
  warningPinkStrong: "rgba(254, 152, 235, 0.4)",
  warningPinkBorder: "rgba(254, 152, 235, 0.16)",
} as const

const unique = {
  backgroundStart: "#090A14",
  backgroundEnd: "#080D33",

  // Switch/toggle states
  switchTrackOff: palette.purpleGray1,
  switchTrackOn: palette.purpleBlue4,
  switchThumb: palette.neutral100,
  switchThumbOn: palette.white,
  switchThumbOff: palette.lightPurple1,
  switchBorder: palette.transparent,

  // Slider states
  sliderThumb: palette.white,
  sliderTrackActive: palette.primary500,
  sliderTrackInactive: palette.neutral600,
} as const

const design = {
  ...getAllColors("dark mode"),
}

export const colors = {
  palette,

  // Text colors
  text: design.secondary_foreground,
  textDim: palette.neutral600,
  textAlt: palette.neutral200,

  // Backgrounds
  // background: palette.neutral100,
  backgroundAlt: palette.neutral200,
  backgroundNeo: palette.neutral100,
  modalOverlay: "rgba(0, 0, 0, 0.7)",

  // Borders
  // border: palette.primary200,
  separator: palette.neutral300,

  // Primary colors
  tint: palette.primary400,
  tintInactive: palette.neutral300,
  buttonIconBackground: palette.darkPurple1, // Icon pill buttons - matches main branch

  // Error states
  error: palette.angry600,
  errorBackground: palette.angry100,
  success: palette.success500,
  warning: palette.accent300,

  // Common:
  // primary: palette.primary500,
  // secondary: palette.secondary300,
  // accent: palette.accent300,

  // Iconography
  icon: palette.neutral900,
  iconSecondary: palette.neutral500,

  // Status chips
  statusIcon: palette.lightPurple1,
  statusText: palette.neutral900,

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
