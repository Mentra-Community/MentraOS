import SwiftUI

@main
struct MentraBareIosExampleApp: App {
    @StateObject private var model = BluetoothViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
        }
    }
}
