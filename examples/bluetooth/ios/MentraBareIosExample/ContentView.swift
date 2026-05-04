import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject private var model: BluetoothViewModel

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GlassesPreviewCard(preview: model.glassesPreview)

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

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Webhook Photo Preview")
                            .font(.headline)

                        Text(model.cameraStatus)
                            .font(.subheadline)

                        if let photoPreviewUrl = model.photoPreviewUrl {
                            AsyncImage(url: photoPreviewUrl) { phase in
                                switch phase {
                                case let .success(image):
                                    image
                                        .resizable()
                                        .scaledToFit()
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                case .failure:
                                    Text("Could not load uploaded photo.")
                                        .foregroundStyle(.red)
                                case .empty:
                                    ProgressView("Loading photo...")
                                @unknown default:
                                    EmptyView()
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 180)
                        }

                        TextField("http://<computer-ip>:8787/upload", text: $model.webhookUrl)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        Button("Take Photo + Upload") {
                            model.requestWebhookPhoto()
                        }
                        .buttonStyle(.borderedProminent)

                        Text(
                            "Run the local webhook server on your computer and paste its printed /upload URL here. The glasses upload directly to that server; this app polls it by requestId and displays the image."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }

                    Text("Log")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Text(model.logText)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(.bottom, 24)
                }
                .padding()
            }
            .navigationTitle("Mentra iOS")
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil
                        )
                    }
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}

private struct GlassesPreviewCard: View {
    let preview: GlassesPreviewState

    var body: some View {
        HStack(spacing: 14) {
            Image(preview.imageName)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 150, maxHeight: 112)

            VStack(alignment: .leading, spacing: 9) {
                Text("Glasses")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color(red: 0.72, green: 0.79, blue: 0.75))
                    .textCase(.uppercase)

                Text(preview.modelName)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Color(red: 1.0, green: 0.98, blue: 0.94))
                    .lineLimit(1)

                HStack(spacing: 8) {
                    PreviewPill(
                        label: preview.connectionText,
                        tint: preview.isConnected ? .green : .white.opacity(0.22)
                    )
                    PreviewPill(
                        label: preview.bluetoothText,
                        tint: preview.isSearching ? .orange : .white.opacity(0.22)
                    )
                }

                MetricRow(label: "Battery", value: preview.batteryText)

                GeometryReader { proxy in
                    let percent = preview.batteryLevel ?? 100
                    let fillWidth = max(0, min(proxy.size.width, proxy.size.width * percent / 100))

                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(.white.opacity(0.16))
                        Capsule()
                            .fill(preview.batteryLevel == nil ? .white.opacity(0.24) : Color(red: 0.49, green: 0.88, blue: 0.65))
                            .frame(width: fillWidth)
                    }
                }
                .frame(height: 8)

                MetricRow(label: "Wi-Fi", value: preview.wifiText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(18)
        .background(
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(Color(red: 0.09, green: 0.15, blue: 0.12))

                Circle()
                    .fill(Color(red: 0.85, green: 0.95, blue: 0.87).opacity(0.22))
                    .frame(width: 180, height: 180)
                    .offset(x: -74, y: -74)
            }
        )
    }
}

private struct PreviewPill: View {
    let label: String
    let tint: Color

    var body: some View {
        Text(label)
            .font(.caption.weight(.bold))
            .foregroundStyle(Color(red: 1.0, green: 0.98, blue: 0.94))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(tint.opacity(0.24))
            )
            .overlay(
                Capsule()
                    .stroke(tint.opacity(0.45), lineWidth: 1)
            )
    }
}

private struct MetricRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(Color(red: 0.72, green: 0.79, blue: 0.75))
            Spacer()
            Text(value)
                .fontWeight(.bold)
                .foregroundStyle(Color(red: 1.0, green: 0.98, blue: 0.94))
                .lineLimit(1)
        }
        .font(.caption)
    }
}
