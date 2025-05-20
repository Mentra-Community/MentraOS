import Foundation

@objc(TestFlightDetector)
class TestFlightDetector: NSObject {
    
    @objc
    func isRunningOnTestFlight() -> Bool {
        // Check if app is running on TestFlight
        // TestFlight apps have a special receipt URL
        guard let receiptURLString = Bundle.main.appStoreReceiptURL?.path else {
            return false
        }
        
        return receiptURLString.contains("sandboxReceipt")
    }
    
    @objc
    static func requiresMainQueueSetup() -> Bool {
        return false
    }
}