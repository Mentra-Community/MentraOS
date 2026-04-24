import { useEffect, useState } from "react";
import {
  Button,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import BluetoothSdk, {
  type BatteryStatusEvent,
  type BluetoothStatus,
  type ButtonPressEvent,
  type GlassesStatus,
} from "@mentra/bluetooth-sdk";
import type { ReactNode } from "react";

export default function App() {
  const [glassesStatus, setGlassesStatus] = useState<Partial<GlassesStatus>>(
    {},
  );
  const [bluetoothStatus, setBluetoothStatus] = useState<
    Partial<BluetoothStatus>
  >({});
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
      setGlassesStatus((current) => ({ ...current, ...changed }));
    });

    const removeBluetooth = BluetoothSdk.onBluetoothStatus((changed) => {
      setBluetoothStatus((current) => ({ ...current, ...changed }));
    });

    const buttonSub = BluetoothSdk.addListener(
      "button_press",
      (event: ButtonPressEvent) => {
        addEvent(`Button ${event.buttonId}: ${event.pressType}`);
      },
    );

    const batterySub = BluetoothSdk.addListener(
      "battery_status",
      (event: BatteryStatusEvent) => {
        addEvent(`Battery ${event.level}%${event.charging ? " charging" : ""}`);
      },
    );

    return () => {
      removeGlasses();
      removeBluetooth();
      buttonSub.remove();
      batterySub.remove();
    };
  }, []);

  function addEvent(message: string) {
    setEvents((current) => [message, ...current].slice(0, 8));
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Mentra Bluetooth SDK</Text>
        <Text style={styles.subtitle}>Partner integration example</Text>

        <Section title="Connection">
          <Button
            title="Scan for Mentra Live"
            onPress={() => BluetoothSdk.findCompatibleDevices("Mentra Live")}
          />
          <Button
            title="Connect default"
            onPress={() => BluetoothSdk.connectDefault()}
          />
          <Button
            title="Connect simulated"
            onPress={() => BluetoothSdk.connectSimulated()}
          />
          <Button
            title="Disconnect"
            onPress={() => BluetoothSdk.disconnect()}
          />
        </Section>

        <Section title="Display">
          <Button
            title="Display hello"
            onPress={() =>
              BluetoothSdk.displayText({
                text: "Hello from Mentra",
                x: 0,
                y: 0,
                size: 24,
              })
            }
          />
          <Button
            title="Clear display"
            onPress={() => BluetoothSdk.clearDisplay()}
          />
        </Section>

        <Section title="Status">
          <Text style={styles.mono}>
            {JSON.stringify({ glassesStatus, bluetoothStatus }, null, 2)}
          </Text>
        </Section>

        <Section title="Recent Events">
          {events.length === 0 ? (
            <Text>No events yet.</Text>
          ) : (
            events.map((event) => <Text key={event}>{event}</Text>)
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.actions}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f5f1e8",
  },
  content: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#16201b",
  },
  subtitle: {
    fontSize: 16,
    color: "#546158",
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  actions: {
    gap: 10,
  },
  mono: {
    fontFamily: "Courier",
    fontSize: 12,
  },
});
