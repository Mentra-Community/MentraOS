const palette = {
  neutral900: "#FFFFFF",
  neutral800: "#F4F2F1",
  neutral700: "#D7CEC9",
  neutral600: "#B6ACA6",
  neutral500: "#978F8A",
  // neutral400: "#564E4A",
  neutral400: "#202761",
  neutral300: "#3C3836",
  neutral200: "#161C47",
  neutral100: "#FFFFFF",

  primary600: "#F4E0D9",
  primary500: "#B0B9FF",
  primary400: "#565E8C",
  primary300: "#4240D1",
  // primary200: "#C76542",
  primary200: "navy",
  primary100: "#A54F31",

  secondary500: "#DCDDE9",
  secondary400: "#BCC0D6",
  secondary300: "#9196B9",
  secondary200: "#626894",
  secondary100: "#41476E",

  accent500: "#FFEED4",
  accent400: "#FFE1B2",
  accent300: "#FDD495",
  accent200: "#FBC878",
  accent100: "#FFBB50",

  angry100: "#F2D6CD",
  angry500: "#C03403",

  // Warning/danger colors
  red500: "#f00", // Bright red for warnings

  // Orange colors
  orange500: "#FF9500", // Warning orange

  // Red error colors
  errorRed: "#FF3B30", // Error red

  // Gallery background colors
  darkGalleryBg: "#121212", // Very dark background for gallery
  lightGalleryBg: "#f0f0f0", // Light background for gallery

  // Common blue colors found in hardcoded values (same as light theme)
  blue100: "#E3F2FD",
  blue200: "#BBDEFB",
  blue300: "#90CAF9",
  blue400: "#42A5F5",
  blue500: "#2196F3", // Material Design Blue - most common hardcoded blue
  blue600: "#1976D2", // Darker blue variant
  blue700: "#1565C0",
  blue800: "#0D47A1",

  // iOS system blue
  iosBlue: "#007AFF",

  // Common gray colors found in hardcoded values (same as light theme)
  gray100: "#F5F5F5",
  gray200: "#EEEEEE",
  gray300: "#E0E0E0",
  gray400: "#BDBDBD",
  gray500: "#9E9E9E",
  gray600: "#757575",
  gray700: "#616161",
  gray800: "#424242",
  gray900: "#212121",

  // Additional grays from hardcoded values
  lightGray: "#CCCCCC",
  mediumGray: "#999999",
  darkGray: "#666666",
  charcoal: "#333333",

  // Success colors
  success100: "#E8F5E8",
  success500: "#4CAF50",

  // Warning colors
  warning100: "#FFF3E0",
  warning500: "#FF9500",

  // Facebook brand color
  facebookBlue: "#4267B2",

  // Common overlay colors
  overlay90: "rgba(0, 0, 0, 0.9)",
  overlay70: "rgba(0, 0, 0, 0.7)",
  overlay60: "rgba(0, 0, 0, 0.6)",
  overlay40: "rgba(0, 0, 0, 0.4)",
  overlay30: "rgba(0, 0, 0, 0.3)",
  overlay10: "rgba(0, 0, 0, 0.1)",
  whiteOverlay90: "rgba(255, 255, 255, 0.9)",
  whiteOverlay85: "rgba(255, 255, 255, 0.85)",
  whiteOverlay70: "rgba(255, 255, 255, 0.7)",

  overlay20: "rgba(25, 16, 21, 0.2)",
  overlay50: "rgba(25, 16, 21, 0.5)",

  // iOS specific colors
  iosSwitchTrack: "#D1D1D6", // iOS switch track color (off state)
  iosBackground: "#f9f9f9", // Light gray background color

  // Tab bar gradient colors (dark theme)
  tabBarGradientStart: "#090A14", // Dark blue for dark theme tab bar start
  tabBarGradientEnd: "#080D33", // Darker blue for dark theme tab bar end

  // Button gradient colors (same for both themes)
  buttonGradientStart: "#4340D3", // Purple-blue for button gradient start
  buttonGradientEnd: "#06114D", // Dark blue for button gradient end

  // Warning background colors
  warningBackground: "rgba(254, 152, 235, 0.2)", // Light pink/magenta warning background with 20% opacity
  warningPink: "#FE98EB", // Solid pink/magenta for destructive actions

  // Input border colors
  inputBorderHighlight: "#B0B9FF", // Light blue border for input fields

  // Button colors for pill-shaped buttons
  buttonPillPrimary: "#B0B9FF", // Light blue for primary pill buttons
  buttonPillSecondary: "#474794", // Dark blue for secondary pill buttons
  buttonPillPrimaryText: "#141434", // Dark text for light primary buttons
  buttonPillSecondaryText: "#FFFFFF", // Light text for dark secondary buttons
} as const

export const colors = {
  palette,
  transparent: "rgba(0, 0, 0, 0)",
  text: palette.neutral800,
  textDim: palette.neutral600,
  background: palette.neutral200,
  border: palette.neutral400,
  tint: palette.primary500,
  tintInactive: palette.neutral300,
  separator: palette.neutral300,
  error: palette.angry500,
  errorBackground: palette.angry100,

  // Login screen gradient (no gradient in dark theme, just background)
  loginGradientStart: palette.neutral200, // Dark background
  loginGradientEnd: palette.neutral200, // Same dark background

  // Semantic color mappings for common UI elements
  buttonPrimary: palette.blue500,
  buttonSecondary: palette.blue500,
  buttonDisabled: palette.lightGray,
  buttonDanger: palette.angry500,

  // Modal and overlay colors
  modalOverlay: palette.overlay70,
  modalBackground: "#1c1c1c", // Dark theme modal background

  // Success and warning states
  success: palette.success500,
  warning: palette.warning500,

  // Switch/toggle colors
  switchTrackOff: "#9E9E9E", // Darker gray for OFF track
  switchTrackOn: "#5A57FF", // Brighter purple-blue for switch track when on
  switchThumb: palette.neutral100,
  switchThumbOff: "#E0E0E0", // More noticeable gray handle for OFF state

  // Gallery specific colors
  galleryBackground: palette.darkGalleryBg,

  // Status/alert colors
  warningOrange: palette.orange500,
  errorRed: palette.errorRed,

  // Loading and activity indicators
  loadingIndicator: palette.blue500,

  // Icon colors
  icon: palette.neutral100, // white icons
  iconSecondary: palette.neutral500, // lighter gray for dark theme

  // Button states
  buttonPressed: palette.neutral700, // Darker state for pressed buttons

  // Tab bar gradients
  tabBarBackground1: palette.tabBarGradientStart,
  tabBarBackground2: palette.tabBarGradientEnd,

  // Fullscreen and modal backgrounds
  fullscreenBackground: palette.neutral900, // Black for fullscreen camera
  fullscreenOverlay: palette.overlay60, // Semi-transparent overlay

  // Permission and action buttons
  permissionButton: palette.iosBlue, // iOS blue for permission requests
  shareButton: palette.blue500, // Blue for share actions
  deleteButton: palette.angry500, // Red for delete actions
  destructiveAction: palette.warningPink, // Pink for destructive actions

  // Badge and notification colors
  badgeBackground: palette.red500, // Red for notification badges

  // Gallery specific
  galleryLoadingIndicator: palette.blue500, // Blue for loading spinners

  // Status and notification colors
  statusSuccess: palette.success500, // Green for success messages
  statusWarning: palette.warning500, // Orange for warning messages
  statusInfo: palette.blue500, // Blue for info messages

  // Modal and picker backgrounds
  pickerBackground: palette.overlay70, // Dark semi-transparent for dark theme pickers

  // Border variations
  borderLight: palette.overlay10, // Very light border

  // Button gradient colors
  buttonGradientStart: palette.buttonGradientStart,
  buttonGradientEnd: palette.buttonGradientEnd,

  // Warning background
  warningBackground: palette.warningBackground,
  warningBackgroundDestructive: "rgba(254, 152, 235, 0.4)", // Pink warning background with 40% opacity

  // Input border highlight
  inputBorderHighlight: palette.inputBorderHighlight,

  // Pill button colors
  buttonPillPrimary: palette.buttonPillPrimary,
  buttonPillSecondary: palette.buttonPillSecondary,
  buttonPillPrimaryText: palette.buttonPillPrimaryText,
  buttonPillSecondaryText: palette.buttonPillSecondaryText,

  // Checkmark color
  checkmark: "#7B79FF", // Brighter purple-blue for checkmarks in dark theme
} as const
