import type {ReactNode} from "react"
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from "react-native"

export function Section(props: {title: string; subtitle?: string; children: ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      {props.subtitle ? <Text style={styles.sectionSubtitle}>{props.subtitle}</Text> : null}
      <View style={styles.sectionBody}>{props.children}</View>
    </View>
  )
}

export function ActionButton(props: {
  label: string
  onPress: () => void
  variant?: "default" | "danger"
  disabled?: boolean
}) {
  const danger = props.variant === "danger"
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({pressed}) => [
        styles.button,
        danger && styles.buttonDanger,
        props.disabled && styles.buttonDisabled,
        pressed && !props.disabled && styles.buttonPressed,
      ]}>
      <Text style={[styles.buttonLabel, danger && styles.buttonLabelDanger]}>{props.label}</Text>
    </Pressable>
  )
}

export function StatusRow(props: {label: string; value: string; busy?: boolean}) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{props.label}</Text>
      <View style={styles.statusValueWrap}>
        {props.busy ? <ActivityIndicator size="small" color="#2563eb" style={styles.statusSpinner} /> : null}
        <Text style={styles.statusValue} numberOfLines={1}>
          {props.value}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#6b7280",
    marginTop: 2,
    marginBottom: 4,
  },
  sectionBody: {
    marginTop: 10,
    gap: 8,
  },
  button: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  buttonDanger: {
    backgroundColor: "#dc2626",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonLabel: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },
  buttonLabelDanger: {
    color: "#ffffff",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  statusLabel: {
    fontSize: 14,
    color: "#374151",
    fontWeight: "500",
  },
  statusValueWrap: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    marginLeft: 12,
  },
  statusSpinner: {
    marginRight: 6,
  },
  statusValue: {
    fontSize: 14,
    color: "#111827",
    flexShrink: 1,
  },
})
