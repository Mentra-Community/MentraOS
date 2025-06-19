//
//  Models.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/3/25.
//

import Foundation

struct AiResponseToG1Model {
  var lines: [String]
  var totalPages: UInt8
  var newScreen: Bool
  var currentPage: UInt8 {
    didSet {
      print("SET : currentPage :\(currentPage)")
    }
  }
  var maxPages: UInt8
  var status: DisplayStatus
}

struct ThirdPartyCloudApp {
  let packageName: String
  let name: String
  let description: String
  let webhookURL: String
  let logoURL: String
  let isRunning: Bool
}


// NCSNotification structure
struct NCSNotification: Codable {
    let msgId: Int
    let type: Int
    let appIdentifier: String
    let title: String
    let subtitle: String
    let message: String
    let timeS: Int
    let date: String
    let displayName: String
    
    enum CodingKeys: String, CodingKey {
        case msgId = "msg_id"
        case type
        case appIdentifier = "app_identifier"
        case title
        case subtitle
        case message
        case timeS = "time_s"
        case date
        case displayName = "display_name"
    }
    
    init(msgId: Int, appIdentifier: String, title: String, subtitle: String, message: String, displayName: String, type: Int = 1) {
        self.msgId = msgId
        self.type = type
        self.appIdentifier = appIdentifier
        self.title = title
        self.subtitle = subtitle
        self.message = message
        self.timeS = Int(Date().timeIntervalSince1970)
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        self.date = dateFormatter.string(from: Date())
        
        self.displayName = displayName
    }
}

// Notification structure
struct G1Notification: Codable {
    let ncsNotification: NCSNotification
    let type: String = "Add"
    
    enum CodingKeys: String, CodingKey {
        case ncsNotification = "ncs_notification"
        case type
    }
    
    // Convert to JSON dictionary
    func toJson() -> [String: Any] {
        guard let data = try? JSONEncoder().encode(self) else { return [:] }
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return jsonObject
    }
    
    // Convert to JSON Data
    func toData() -> Data? {
        guard let jsonString = try? JSONEncoder().encode(self) else { return nil }
        return jsonString
    }
    
    // Build notification chunks
    func constructNotification() async -> [[UInt8]] {
        guard let jsonData = self.toData() else { return [] }
        
        let maxChunkSize = 176 // 180 - 4 bytes for header
        var chunks: [Data] = []
        
        // Split data into chunks
        var offset = 0
        while offset < jsonData.count {
            let endIndex = min(offset + maxChunkSize, jsonData.count)
            let chunkData = jsonData.subdata(in: offset..<endIndex)
            chunks.append(chunkData)
            offset = endIndex
        }
        
        let totalChunks = UInt8(chunks.count)
        var encodedChunks: [[UInt8]] = []
        
        // Create packets with headers
        for (index, chunk) in chunks.enumerated() {
            let notifyId: UInt8 = 0 // Set appropriate notification ID
            let header: [UInt8] = [0x4B, notifyId, totalChunks, UInt8(index)]
            
            // Convert chunk data to array of bytes
            var chunkBytes = [UInt8](chunk)
            
            // Combine header and chunk
            var encodedChunk = header
            encodedChunk.append(contentsOf: chunkBytes)
            
            encodedChunks.append(encodedChunk)
        }
        
        return encodedChunks
    }
}
