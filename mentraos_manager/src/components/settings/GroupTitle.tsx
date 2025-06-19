import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, StyleSheet} from "react-native"
import {Text} from "@/components/ignite"

type GroupTitleProps = {
  title: string
}

const GroupTitle: React.FC<GroupTitleProps> = ({title}) => {
  const {theme, themed} = useAppTheme()
  return (
    <View
      style={[
        styles.container,
        {
          marginTop: theme.spacing.md,
          marginBottom: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
        },
      ]}>
      <Text text={title} style={[styles.title, {color: theme.colors.textDim}]} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  title: {
    fontSize: 16,
    fontWeight: "normal",
  },
})

export default GroupTitle
