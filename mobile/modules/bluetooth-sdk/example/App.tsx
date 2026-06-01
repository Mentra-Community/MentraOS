import BluetoothSdk, {DeviceModels} from "@mentra/bluetooth-sdk"
import type {ReactNode} from "react"
// The SDK example intentionally uses plain React Native primitives outside the mobile app shell.
// eslint-disable-next-line no-restricted-imports
import {Button, SafeAreaView, ScrollView, Text, View} from "react-native"

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>Mentra Bluetooth SDK Example</Text>
        <Group name="Connection">
          <Button
            title="Scan and connect Mentra Live"
            onPress={async () => {
              const devices = await BluetoothSdk.scan(DeviceModels.MentraLive)
              if (devices[0]) {
                await BluetoothSdk.connect(devices[0])
              }
            }}
          />
          <Button
            title="Disconnect"
            onPress={async () => {
              await BluetoothSdk.disconnect()
            }}
          />
        </Group>
      </ScrollView>
    </SafeAreaView>
  )
}

function Group(props: {name: string; children: ReactNode}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  )
}

const styles = {
  header: {
    fontSize: 30,
    margin: 20,
  },
  groupHeader: {
    fontSize: 20,
    marginBottom: 20,
  },
  group: {
    margin: 20,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 20,
  },
  container: {
    flex: 1,
    backgroundColor: "#eee",
  },
}
