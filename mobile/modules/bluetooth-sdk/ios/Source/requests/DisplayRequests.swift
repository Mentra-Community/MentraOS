import Foundation

public struct DisplayTextRequest {
    public let text: String
    public let x: Int
    public let y: Int
    public let size: Int

    public init(text: String, x: Int = 0, y: Int = 0, size: Int = 24) {
        self.text = text
        self.x = x
        self.y = y
        self.size = size
    }

    var dictionary: [String: Any] {
        [
            "text": text,
            "x": x,
            "y": y,
            "size": size,
        ]
    }
}

struct DisplayEventRequest {
    let values: [String: Any]
}

public struct DashboardPositionRequest {
    public let height: Int
    public let depth: Int

    public init(height: Int, depth: Int) {
        self.height = height
        self.depth = depth
    }
}

struct DashboardMenuItem {
    let title: String
    let packageName: String
    let values: [String: Any]

    init(title: String, packageName: String, values: [String: Any] = [:]) {
        self.title = title
        self.packageName = packageName
        self.values = values
    }

    var dictionary: [String: Any] {
        values.merging(["title": title, "packageName": packageName]) { _, new in new }
    }
}

/// Mirrors the TS `CalendarEvent` shape: { title, location?, time, endDate }
/// where `endDate` is unix seconds.
struct CalendarEvent {
    let title: String
    let location: String?
    let time: String
    let endDate: Double

    init(title: String, location: String? = nil, time: String, endDate: Double) {
        self.title = title
        self.location = location
        self.time = time
        self.endDate = endDate
    }

    var dictionary: [String: Any] {
        var dict: [String: Any] = [
            "title": title,
            "time": time,
            "endDate": endDate,
        ]
        if let location {
            dict["location"] = location
        }
        return dict
    }
}
