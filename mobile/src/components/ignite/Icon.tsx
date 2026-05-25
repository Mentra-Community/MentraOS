import {createIconSet} from "@expo/vector-icons"
import glyphMap from "@assets/icons/tabler/glyph-map.json"
import {
  Bell,
  CircleUser,
  CircleX,
  Cog,
  Ellipsis,
  ExternalLink,
  FileType2,
  Fullscreen,
  Glasses,
  Grid3X3,
  Info,
  LayoutDashboard,
  Locate,
  Minus,
  PauseIcon,
  PlayIcon,
  PointerIcon,
  Share,
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

import {GridIcon, HomeIcon, ShoppingBagIcon} from "@/components/icons"
import {useAppTheme} from "@/contexts/ThemeContext"

const TablerIcon = createIconSet(glyphMap, "tablerIcons", "tabler-icons.ttf")

const lucideIcons = {
  "circle-user": CircleUser,
  fullscreen: Fullscreen,
  glasses: Glasses,
  bell: Bell,
  "file-type-2": FileType2,
  "user-round": UserRound,
  "user-round-filled": UserRound,
  wifi: Wifi,
  unplug: Unplug,
  unlink: Unlink,
  locate: Locate,
  "layout-dashboard": LayoutDashboard,
  "wifi-off": WifiOff,
  info: Info,
  // custom icons:
  grid: GridIcon,
  "shopping-bag": ShoppingBagIcon,
  "shopping-bag-filled": ShoppingBagIcon,
  house: HomeIcon,
  "house-filled": HomeIcon,
  ellipsis: Ellipsis,
  minus: Minus,
  "grid-3x3": Grid3X3,
  share: Share,
  cog: Cog,
  "external-link": ExternalLink,
  play: PlayIcon,
  pause: PauseIcon,
  pointer: PointerIcon,
  "circle-x": CircleX,
}

const tablerIcons = {
  settings: 1,
  bluetooth: 1,
  "bluetooth-connected": 1,
  "bluetooth-off": 1,
  "battery-3": 1,
  "battery-2": 1,
  "battery-1": 1,
  "battery-0": 1,
  "arrow-left": 1,
  "arrow-right": 1,
  x: 1,
  "message-2-star": 1,
  "shield-lock": 1,
  "user-code": 1,
  user: 1,
  "user-filled": 1,
  sun: 1,
  microphone: 1,
  "device-ipad": 1,
  "device-airpods-case": 1,
  "brightness-half": 1,
  "battery-charging": 1,
  alert: 1,
  "exclamation-circle": 1,
  "chevron-left": 1,
  "chevron-right": 1,
  "info-circle": 1,
  trash: 1,
  "trash-x": 1,
  check: 1,
  "world-download": 1,
  repeat: 1,
  mail: 1,
  "chevron-down": 1,
  "chevron-up": 1,
  "alert-triangle": 1,
  plus: 1,
  search: 1,
} as const

export const iconRegistry = {
  ...tablerIcons,
  ...lucideIcons,
}

type TablerIconName = keyof typeof glyphMap
type LucideIconName = keyof typeof lucideIcons
type LegacyIconName = keyof typeof tablerIcons
export type IconTypes = TablerIconName | LucideIconName | LegacyIconName | (string & {})

type BaseIconProps = {
  /** The name of the icon. */
  name?: IconTypes
  /** Legacy prop accepted by existing call sites. It is intentionally ignored here to preserve runtime behavior. */
  icon?: IconTypes
  /** An optional tint color for the icon. */
  color?: string
  /** An optional background color for the icon. */
  backgroundColor?: string
  /** An optional size for the icon. If not provided, the icon will be sized to the icon's resolution. */
  size?: number
  /** Style overrides for the icon image. */
  style?: StyleProp<ImageStyle>
  /** Style overrides for the icon container. */
  containerStyle?: StyleProp<ViewStyle>
}

type PressableIconProps = Omit<TouchableOpacityProps, "style"> & BaseIconProps
type IconProps = Omit<ViewProps, "style"> & BaseIconProps

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

  if (name && isLucideIconName(name)) {
    const IconComponent = lucideIcons[name] as any

    return (
      <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
        <IconComponent style={$imageStyle} size={size} color={color} fill={backgroundColor ?? "transparent"} />
      </View>
    )
  }

  if (name && isTablerIconName(name)) {
    return (
      <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
        <TablerIcon style={$textStyle} name={name} size={size} color={color} />
      </View>
    )
  }

  return (
    <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
      <Image style={$imageStyle} source={(iconRegistry as Record<string, any>)[name as string]} />
    </View>
  )
}

function isLucideIconName(name: IconTypes): name is LucideIconName {
  return name in lucideIcons
}

function isTablerIconName(name: IconTypes): name is TablerIconName {
  return name in glyphMap
}

const $iconCenterStyle: ViewStyle = {}

const $imageStyleBase: ImageStyle = {
  resizeMode: "contain",
}
