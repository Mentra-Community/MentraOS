import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: BluetoothViewModel

    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.statusSummary)
                    .font(.headline)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    Button("Scan") {
                        model.scan()
                    }
                    Button("Connect") {
                        model.connect()
                    }
                    Button("Display Hello") {
                        model.displayHello()
                    }
                    Button("Apply Settings") {
                        model.applyDisplaySettings()
                    }
                    Button("Clear Display") {
                        model.clearDisplay()
                    }
                    Button("Disconnect") {
                        model.disconnect()
                    }
                }
                .buttonStyle(.borderedProminent)

                Text("Log")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                ScrollView {
                    Text(model.logText)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
            .navigationTitle("Mentra iOS")
        }
        .navigationViewStyle(.stack)
    }
}
