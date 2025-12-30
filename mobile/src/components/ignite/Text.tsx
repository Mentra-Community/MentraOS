import {TOptions} from "i18next"
import {ReactNode, forwardRef, ForwardedRef} from "react"
// eslint-disable-next-line no-restricted-imports
import {StyleProp, Text as RNText, TextProps as RNTextProps, TextStyle} from "react-native"

import {isRTL, translate, TxKeyPath} from "@/i18n"
import type {ThemedStyle, ThemedStyleArray} from "@/theme"
import {typography} from "@/theme/typography"
import {useAppTheme} from "@/utils/useAppTheme"
import {withUniwind} from "uniwind"
import {StyleSheet} from "react-native"
// import { flatten } from 'react-native/Libraries/StyleSheet/';

type Sizes = keyof typeof $sizeStyles
type Weights = keyof typeof typography.primary
type Presets = "default" | "bold" | "heading" | "subheading" | "formLabel" | "formHelper"

export interface TextProps extends RNTextProps {
  /**
   * Text which is looked up via i18n.
   */
  tx?: TxKeyPath
  /**
   * The text to display if not using `tx` or nested components.
   */
  text?: string
  /**
   * Optional options to pass to i18n. Useful for interpolation
   * as well as explicitly setting locale or translation fallbacks.
   */
  txOptions?: TOptions
  /**
   * An optional style override useful for padding & margin.
   */
  style?: StyleProp<TextStyle>
  /**
   * One of the different types of text presets.
   */
  preset?: Presets
  /**
   * Text weight modifier.
   */
  weight?: Weights
  /**
   * Text size modifier.
   */
  size?: Sizes
  /**
   * Children components.
   */
  children?: ReactNode
}

/**
 * For your text displaying needs.
 * This component is a HOC over the built-in React Native one.
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Text/}
 * @param {TextProps} props - The props for the `Text` component.
 * @returns {JSX.Element} The rendered `Text` component.
 */
export const TextBase = forwardRef(function Text(props: TextProps, ref: ForwardedRef<RNText>) {
  const {weight, size, tx, txOptions, text, children, style: $styleOverride, ...rest} = props
  const {themed} = useAppTheme()

  const i18nText = tx && translate(tx, txOptions)
  const content = i18nText || text || children

  const preset: Presets = props.preset ?? "default"

  // map style.weight to $fontWeightStyles:
  // let styleWeight = $styleOverride?["fon"]

  // console.log("styleOverride: ", $styleOverride)
  // if ($styleOverride?.valueOf())

  // extract fontWeight from the styleOverride:
  let weightOverride: Weights | undefined = undefined;
  const mStyles = StyleSheet.flatten($styleOverride) as TextStyle | undefined;
  if (mStyles?.fontWeight) {
    switch (mStyles.fontWeight) {
      case 100:
        // weightOverride = "thin"
        weightOverride = "light"
        break
      case 200:
        // weightOverride = "extraLight"
        weightOverride = "light"
        break
      case 300:
        weightOverride = "light"
        break
      case 400:
        weightOverride = "normal"
        break
      case 500:
        weightOverride = "medium"
        break
      case 600:
        weightOverride = "semibold"
        break
      case 700:
        weightOverride = "bold"
        break
      case 800:
        // weightOverride = "extrabold"
        weightOverride = "bold"
        break
      case 900:
        // weightOverride = "black"
        weightOverride = "bold"
        break
      default:
        break
    }
  }
  // const merged = Object.assign({}, ...($styleOverride as any));
  // merge the styleOverrideArrays into a single object:
  // const styleOverrideObject = styleOverrideArray.reduce((acc, curr) => {
  //   return {...acc, ...curr}
  // }, {})

  const $styles: StyleProp<TextStyle> = [
    $rtlStyle,
    themed($presets[preset]),
    weight && $fontWeightStyles[weight],
    size && $sizeStyles[size],
    weightOverride && $fontWeightStyles[weightOverride],
    $styleOverride,
  ]

  return (
    <RNText {...rest} style={$styles} ref={ref}>
      {content}
    </RNText>
  )
})

export const Text = withUniwind(TextBase)

const $sizeStyles = {
  // xxl: {fontSize: 36, lineHeight: 44} satisfies TextStyle,
  // xl: {fontSize: 24, lineHeight: 34} satisfies TextStyle,
  // lg: {fontSize: 20, lineHeight: 32} satisfies TextStyle,
  // md: {fontSize: 18, lineHeight: 26} satisfies TextStyle,
  // sm: {fontSize: 16, lineHeight: 24} satisfies TextStyle,
  // xs: {fontSize: 14, lineHeight: 21} satisfies TextStyle,
  // xxs: {fontSize: 12, lineHeight: 18} satisfies TextStyle,
  xxl: {fontSize: 36, lineHeight: 44} satisfies TextStyle,
  xl: {fontSize: 24, lineHeight: 34} satisfies TextStyle,
  lg: {fontSize: 20, lineHeight: 32} satisfies TextStyle,
  // md: {fontSize: 18, lineHeight: 26} satisfies TextStyle,
  md: {fontSize: 16, lineHeight: 24} satisfies TextStyle,
  xs: {fontSize: 14, lineHeight: 21} satisfies TextStyle,
  xxs: {fontSize: 12, lineHeight: 18} satisfies TextStyle,
}

const $fontWeightStyles = Object.entries(typography.primary).reduce((acc, [weight, fontFamily]) => {
  return {...acc, [weight]: {fontFamily}}
}, {}) as Record<Weights, TextStyle>

const $baseStyle: ThemedStyle<TextStyle> = theme => ({
  ...$sizeStyles.sm,
  ...$fontWeightStyles.normal,
  color: theme.colors.secondary_foreground,
})

const $presets: Record<Presets, ThemedStyleArray<TextStyle>> = {
  default: [$baseStyle],
  bold: [$baseStyle, {...$fontWeightStyles.bold}],
  heading: [
    $baseStyle,
    {
      ...$sizeStyles.xxl,
      ...$fontWeightStyles.bold,
    },
  ],
  subheading: [$baseStyle, {...$sizeStyles.lg, ...$fontWeightStyles.medium}],
  formLabel: [$baseStyle, {...$fontWeightStyles.medium}],
  formHelper: [$baseStyle, {...$sizeStyles.sm, ...$fontWeightStyles.normal}],
}
const $rtlStyle: TextStyle = isRTL ? {writingDirection: "rtl"} : {}
