import {Children, isValidElement, cloneElement} from "react"
import {View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export const Group = ({title, style, children}: {title?: string; style?: ViewStyle; children?: React.ReactNode}) => {
  const {themed} = useAppTheme()

  const childrenArray = Children.toArray(children)

  // hide if no child elements:
  if (!childrenArray.length) return null

  const childrenWithProps = childrenArray.map((child, index) => {
    if (!isValidElement(child)) return child

    let position: "top" | "middle" | "bottom" | null
    if (childrenArray.length === 1) {
      position = null // when there is only one element, apply uniform border radius
    } else if (index === 0) {
      position = "top"
    } else if (index === childrenArray.length - 1) {
      position = "bottom"
    } else {
      position = "middle"
    }

    let containerStyle
    if (position === "top") {
      containerStyle = themed($top)
    } else if (position === "bottom") {
      containerStyle = themed($bottom)
    } else if (position === "middle") {
      containerStyle = themed($middle)
    } else {
      containerStyle = themed($none)
    }

    return cloneElement(child, {
      key: index,
      // @ts-ignore
      style: [child.props.style, containerStyle],
    } as any)
  })

  return (
    <View style={[themed($container), style]}>
      {title && <Text>{title}</Text>}
      {childrenWithProps}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  gap: spacing.s2,
})

const $top: ThemedStyle<ViewStyle> = ({spacing}) => ({
  borderRadius: spacing.s4,
  borderBottomLeftRadius: spacing.s1,
  borderBottomRightRadius: spacing.s1,
})

const $bottom: ThemedStyle<ViewStyle> = ({spacing}) => ({
  borderRadius: spacing.s4,
  borderTopLeftRadius: spacing.s1,
  borderTopRightRadius: spacing.s1,
})

const $middle: ThemedStyle<ViewStyle> = ({spacing}) => ({
  borderRadius: spacing.s1,
})

const $none: ThemedStyle<ViewStyle> = ({spacing}) => ({
  borderRadius: spacing.s4,
})
