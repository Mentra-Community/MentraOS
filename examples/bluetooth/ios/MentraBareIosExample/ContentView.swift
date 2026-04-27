import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject private var model: BluetoothViewModel

    var body: some View {
        NavigationView {
            ScrollView {
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
