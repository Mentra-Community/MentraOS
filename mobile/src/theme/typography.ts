// TODO: write documentation about fonts and typography along with guides on how to add custom fonts in own
// markdown file and add links from here

import {
  RedHatDisplay_300Light as redHatDisplayLight,
  RedHatDisplay_400Regular as redHatDisplayRegular,
  RedHatDisplay_500Medium as redHatDisplayMedium,
  RedHatDisplay_600SemiBold as redHatDisplaySemiBold,
  RedHatDisplay_700Bold as redHatDisplayBold,
  RedHatDisplay_800ExtraBold as redHatDisplayExtraBold,
  RedHatDisplay_900Black as redHatDisplayBlack,
  RedHatDisplay_300Light_Italic as redHatDisplayLightItalic,
  RedHatDisplay_400Regular_Italic as redHatDisplayRegularItalic,
  // RedHatDisplay_500Medium_Italic as redHatDisplayMediumItalic,
  // RedHatDisplay_600SemiBold_Italic as redHatDisplaySemiBoldItalic,
} from "@expo-google-fonts/red-hat-display"
import {
  SpaceGrotesk_300Light as spaceGroteskLight,
  SpaceGrotesk_400Regular as spaceGroteskRegular,
  SpaceGrotesk_500Medium as spaceGroteskMedium,
  SpaceGrotesk_600SemiBold as spaceGroteskSemiBold,
  SpaceGrotesk_700Bold as spaceGroteskBold,
} from "@expo-google-fonts/space-grotesk"
import {Platform} from "react-native"

export const customFontsToLoad = {
  spaceGroteskLight,
  spaceGroteskRegular,
  spaceGroteskMedium,
  spaceGroteskSemiBold,
  spaceGroteskBold,
  glassesMirror: require("@assets/fonts/glassesmirror.ttf"),
  tablerIcons: require("@assets/icons/tabler/tabler-icons.ttf"),
  redHatDisplayLight,
  redHatDisplayRegular,
  redHatDisplayMedium,
  redHatDisplaySemiBold,
  redHatDisplayBold,
  redHatDisplayExtraBold,
  redHatDisplayBlack,
  redHatDisplayLightItalic,
  redHatDisplayRegularItalic,
}

const fonts = {
  spaceGrotesk: {
    // Cross-platform Google font.
    light: "spaceGroteskLight",
    normal: "spaceGroteskRegular",
    medium: "spaceGroteskMedium",
    semiBold: "spaceGroteskSemiBold",
    bold: "spaceGroteskBold",
  },
  sfProRounded: {
    // SF Pro Rounded - the cool robot font
    light: Platform.select({ios: "SF Pro Rounded", android: "sans-serif-light"}),
    normal: Platform.select({ios: "SF Pro Rounded", android: "sans-serif"}),
    medium: Platform.select({ios: "SF Pro Rounded", android: "sans-serif-medium"}),
    semiBold: Platform.select({ios: "SF Pro Rounded", android: "sans-serif-medium"}),
    bold: Platform.select({ios: "SF Pro Rounded", android: "sans-serif"}),
  },
  helveticaNeue: {
    // iOS only font.
    thin: "HelveticaNeue-Thin",
    light: "HelveticaNeue-Light",
    normal: "Helvetica Neue",
    medium: "HelveticaNeue-Medium",
  },
  courier: {
    // iOS only font.
    normal: "Courier",
  },
  sansSerif: {
    // Android only font.
    thin: "sans-serif-thin",
    light: "sans-serif-light",
    normal: "sans-serif",
    medium: "sans-serif-medium",
  },
  monospace: {
    // Android only font.
    normal: "monospace",
  },
  glassesMirror: {
    // Custom font for glasses display mirror
    normal: "glassesMirror",
  },
  redHatDisplay: {
    light: "redHatDisplayLight",
    normal: "redHatDisplayRegular",
    medium: "redHatDisplayMedium",
    semiBold: "redHatDisplaySemiBold",
    bold: "redHatDisplayBold",
  },
}

export const typography = {
  /**
   * The fonts are available to use, but prefer using the semantic name.
   */
  fonts,
  /**
   * The primary font. Used in most places.
   */
  primary: fonts.redHatDisplay,
  /**
   * An alternate font used for perhaps titles and stuff.
   */
  secondary: fonts.spaceGrotesk,
  /**
   * Lets get fancy with a monospace font!
   */
  code: Platform.select({ios: fonts.courier, android: fonts.monospace}),
}
