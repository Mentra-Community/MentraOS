import {createIconSet} from "@expo/vector-icons"
import {
  Bell,
  CircleUser,
  FileType2,
  Fullscreen,
  Glasses,
  Info,
  LayoutDashboard,
  Locate,
  Unlink,
  Unplug,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react-native"
import {
  Image,
  ImageStyle,
  StyleProp,
  TextStyle,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewProps,
  ViewStyle,
} from "react-native"

import {ShoppingBagIcon, HomeIcon} from "@/components/icons"
import {useAppTheme} from "@/contexts/ThemeContext"

export type IconTypes = keyof typeof iconRegistry

type BaseIconProps = {
  /**
   * The name of the icon
   */
  name: IconTypes

  /**
   * An optional tint color for the icon
   */
  color?: string

  /**
   * An optional background color for the icon
   */
  backgroundColor?: string

  /**
   * An optional size for the icon. If not provided, the icon will be sized to the icon's resolution.
   */
  size?: number

  /**
   * Style overrides for the icon image
   */
  style?: StyleProp<ImageStyle>

  /**
   * Style overrides for the icon container
   */
  containerStyle?: StyleProp<ViewStyle>
}

type PressableIconProps = Omit<TouchableOpacityProps, "style"> & BaseIconProps
type IconProps = Omit<ViewProps, "style"> & BaseIconProps

/**
 * A component to render a registered icon.
 * It is wrapped in a <TouchableOpacity />
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Icon/}
 * @param {PressableIconProps} props - The props for the `PressableIcon` component.
 * @returns {JSX.Element} The rendered `PressableIcon` component.
 */
export function PressableIcon(props: PressableIconProps) {
  const {
    name,
    color,
    // backgroundColor,
    size,
    // style: $imageStyleOverride,
    containerStyle: $containerStyleOverride,
    ...pressableProps
  } = props

  const {theme} = useAppTheme()

  return (
    <TouchableOpacity {...pressableProps} style={$containerStyleOverride}>
      <Icon name={name} size={size} color={color ?? theme.colors.secondary_foreground} />
    </TouchableOpacity>
  )
}

const glyphMap = require("@assets/icons/tabler/glyph-map.json")
const TablerIcon = createIconSet(glyphMap, "tablerIcons", "tabler-icons.ttf")

const lucideIcons = {
  "circle-user": CircleUser,
  "fullscreen": Fullscreen,
  "glasses": Glasses,
  "bell": Bell,
  "file-type-2": FileType2,
  "user-round": UserRound,
  "user-round-filled": UserRound,
  "wifi": Wifi,
  "unplug": Unplug,
  "unlink": Unlink,
  "locate": Locate,
  "layout-dashboard": LayoutDashboard,
  "wifi-off": WifiOff,
  "info": Info,
  // "house": House,
  // custom icons:
  "shopping-bag": ShoppingBagIcon,
  "shopping-bag-filled": ShoppingBagIcon,
  "house": HomeIcon,
  "house-filled": HomeIcon,
}

const tablerIcons = {
  "settings": 1,
  "bluetooth-connected": 1,
  "bluetooth-off": 1,
  "battery-3": 1,
  "battery-2": 1,
  "battery-1": 1,
  "battery-0": 1,
  "arrow-left": 1,
  "arrow-right": 1,
  "x": 1,
  "message-2-star": 1,
  "shield-lock": 1,
  "user-code": 1,
  "user": 1,
  "user-filled": 1,
  "sun": 1,
  "microphone": 1,
  "device-ipad": 1,
  "device-airpods-case": 1,
  "brightness-half": 1,
  "battery-charging": 1,
  "alert": 1,
  "chevron-left": 1,
  "chevron-right": 1,
  "trash": 1,
  "trash-x": 1,
  "check": 1,
  "world-download": 1,
  "repeat": 1,
  "mail": 1,
  "chevron-down": 1,
  "chevron-up": 1,
}

/**
 * A component to render a registered icon.
 * It is wrapped in a <View />, use `PressableIcon` if you want to react to input
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Icon/}
 * @param {IconProps} props - The props for the `Icon` component.
 * @returns {JSX.Element} The rendered `Icon` component.
 */
export function Icon(props: IconProps) {
  const {
    name,
    color,
    backgroundColor,
    size,
    style: $imageStyleOverride,
    containerStyle: $containerStyleOverride,
    ...viewProps
  } = props

  const {theme} = useAppTheme()

  const $imageStyle: StyleProp<ImageStyle> = [
    $imageStyleBase,
    {tintColor: color ?? theme.colors.text},
    size !== undefined && {width: size, height: size},
    $imageStyleOverride,
  ]

  const $textStyle: StyleProp<TextStyle> = [
    size !== undefined && {fontSize: size, lineHeight: size, width: size, height: size},
  ]

  // @ts-ignore
  if (lucideIcons[name]) {
    // @ts-ignore
    const IconComponent = lucideIcons[name] as any

    return (
      <View {...viewProps} style={$containerStyleOverride}>
        <IconComponent style={$imageStyle} size={size} color={color} fill={backgroundColor ?? "transparent"} />
      </View>
    )
  }

  if (TablerIcon.glyphMap[name]) {
    return (
      <View {...viewProps} style={$containerStyleOverride}>
        <TablerIcon style={$textStyle} name={name} size={size} color={color} />
      </View>
    )
  }

  return (
    <View {...viewProps} style={$containerStyleOverride}>
      <Image style={$imageStyle} source={iconRegistry[name] as any} />
    </View>
  )
}

export const iconRegistry = {
  // included in other font sets (imported automatically):
  // included here mostly for ide/type hinting purposes:
  // tabler icons:
  ...tablerIcons,
  // lucide-react-native icons:
  ...lucideIcons,
}

const $imageStyleBase: ImageStyle = {
  resizeMode: "contain",
}
