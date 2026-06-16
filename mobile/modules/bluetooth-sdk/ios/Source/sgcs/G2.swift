//
//  G2.swift
//  MentraOS_Manager
//
//  Rewritten for EvenHub protocol (G2-native protobuf-based display system)
//  Based on reverse-engineered protocol from ae_g2_rev
//

import Combine
import CoreBluetooth
import Foundation
import UIKit

// MARK: - Data Little-Endian Helpers (for BMP construction)

extension Data {
    fileprivate mutating func appendLittleEndian(_ value: UInt16) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }

    fileprivate mutating func appendLittleEndian(_ value: UInt32) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }

    fileprivate mutating func appendLittleEndian(_ value: Int32) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }
}

// MARK: - G2 Protocol Constants

private enum G2BLE {
    // EvenHub BLE characteristic UUIDs (NOT the G1 UART UUIDs!)
    static let CHAR_WRITE = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")
    static let CHAR_NOTIFY = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")
    static let AUDIO_NOTIFY = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E6402")

    /// We discover services by scanning for these characteristics
    /// The service UUID that contains these chars
    static let SERVICE_UUID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0000")

    // Transport constants
    static let HEADER_BYTE: UInt8 = 0xAA
    static let SOURCE_PHONE: UInt8 = 1
    static let DEST_GLASSES: UInt8 = 2
    static let MAX_PACKET_PAYLOAD: Int = 236
}

/// Service IDs from service_id_def.proto
private enum ServiceID: UInt8 {
    case dashboard = 1  // 0x01 - UI_BACKGROUND_DASHBOARD_APP_ID
    case menu = 3  // 0x03 - UI_FOREGROUND_MEUN_ID (typo is intentional — matches Even's proto)
    case notification = 4  // 0x04 - UI_FOREGROUND_NOTIFICATION_ID
    case evenAI = 7  // 0x07 - UI_FOREGROUND_EVEN_AI_ID
    case navigation = 8  // 0x08 - UI_BACKGROUND_NAVIGATION_ID (compass/heading lives here)
    case g2Setting = 9  // 0x09 - UI_SETTING_APP_ID
    case gestureCtrl = 13  // 0x0D - gesture_ctrl lifecycle signals
    case onboarding = 16  // 0x10 - UI_ONBOARDING_APP_ID
    case deviceSettings = 128  // 0x80 - UX_DEVICE_SETTINGS_APP_ID
    case evenHubCtrl = 129  // 0x81 - EvenHub CTRL channel (init/registration)
    case evenHub = 224  // 0xE0 - UI_BACKGROUND_EVENHUB_APP_ID
}

/// EvenHub command IDs from EvenHub.proto
private enum EvenHubCmd: Int32 {
    case createStartupPage = 0  // APP_REQUEST_CREATE_STARTUP_PAGE_PACKET
    case updateImageRawData = 3  // APP_UPDATE_IMAGE_RAW_DATA_PACKET
    case updateTextData = 5  // APP_UPDATE_TEXT_DATA_PACKET
    case rebuildPage = 7  // APP_REQUEST_REBUILD_PAGE_PACKET
    case shutdownPage = 9  // APP_REQUEST_SHUTDOWN_PAGE_PACKET
    case heartbeat = 12  // APP_REQUEST_HEARTBEAT_PACKET
    case audioControl = 15  // APP_REQUEST_AUDIO_CTR_PACKET
    case imuControl = 19  // APP_REQUEST_IMU_CTR_PACKET (confirmed via on-device brute-force)
}

/// Navigation_Cmd_list from navigation.proto (service 0x08)
private enum NavigationCmd: Int32 {
    case appSendHeartbeat = 0  // APP_SEND_HEARTBEAT_CMD
    case appRequestStartUp = 5  // APP_REQUEST_START_UP — begin navigation/compass session
    case appSendBasicInfo = 7  // APP_SEND_BASIC_INFO
    case appRequestExit = 12  // APP_REQUEST_EXIT
    case osNotifyExit = 13  // OS_NOTIFY_EXIT
    case osNotifyReviewChanged = 14  // OS_NOTIFY_REVIEW_CHANGED
    case osNotifyCompassChanged = 15  // OS_NOTIFY_COMPASS_CHANGED — heading update
    case osNotifyCompassCalibrateStart = 16  // OS_NOTIFY_COMPASS_CALIBRATE_STRAT (sic)
    case osNotifyCompassCalibrateComplete = 17  // OS_NOTIFY_COMPASS_CALIBRATE_COMPLETE
}

/// EvenHub response command IDs (from glasses → phone)
private enum EvenHubResponseCmd: Int32 {
    case osNotifyEventToApp = 2  // OS_NOITY_EVENT_TO_APP_PACKET - touch/gesture events
}

/// OsEventTypeList from EvenHub.proto
private enum OsEventType: Int32 {
    case click = 0
    case scrollTop = 1
    case scrollBottom = 2
    case doubleClick = 3
    case foregroundEnter = 4
    case foregroundExit = 5
    case abnormalExit = 6
    case systemExit = 7
    case imuDataReport = 8  // IMU_DATA_REPORT — Sys_ItemEvent carries imuData
}

/// g2_settingCommandId from g2_setting.proto
private enum G2SettingCommandId: Int32 {
    case none = 0
    case deviceReceiveInfo = 1  // Send settings TO glasses
    case deviceReceiveRequest = 2  // Request info FROM glasses
    case deviceSendToApp = 3  // Glasses sends info TO app
    case deviceRespondToApp = 4  // Glasses responds to app
}

/// DevCfgCommandId from dev_config_protocol.proto
private enum DevCfgCommandId: Int32 {
    case authentication = 4
    case pipeRoleChange = 5
    case ringConnectInfo = 6
    case timeSync = 128
    case baseConnHeartBeat = 14
}

// MARK: - CRC16 (matches Python calc_crc)

private func calcCRC16(_ data: Data) -> UInt16 {
    var crc: UInt16 = 0xFFFF
    for byte in data {
        crc = ((crc >> 8) | ((crc << 8) & 0xFF00)) ^ UInt16(byte)
        crc ^= (crc & 0xFF) >> 4
        crc ^= (crc << 12) & 0xFFFF
        crc ^= ((crc & 0xFF) << 5) & 0xFFFF
    }
    return crc & 0xFFFF
}

// MARK: - Minimal Protobuf Encoding Helpers

// We manually encode protobuf messages rather than using codegen.
// This keeps dependencies minimal and matches the known field numbers from the .proto files.

private struct ProtobufWriter {
    private(set) var data = Data()

    /// Varint encoding
    mutating func writeVarint(_ value: UInt64) {
        var v = value
        while v > 0x7F {
            data.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        data.append(UInt8(v))
    }

    mutating func writeInt32Field(_ fieldNumber: Int, _ value: Int32) {
        let tag = UInt64(fieldNumber << 3) | 0  // wire type 0 = varint
        writeVarint(tag)
        // protobuf int32 uses varint encoding; negative values use 10 bytes
        if value >= 0 {
            writeVarint(UInt64(value))
        } else {
            writeVarint(UInt64(bitPattern: Int64(value)))
        }
    }

    mutating func writeInt64Field(_ fieldNumber: Int, _ value: Int64) {
        let tag = UInt64(fieldNumber << 3) | 0  // wire type 0 = varint
        writeVarint(tag)
        writeVarint(UInt64(bitPattern: value))
    }

    mutating func writeStringField(_ fieldNumber: Int, _ value: String) {
        let tag = UInt64(fieldNumber << 3) | 2  // wire type 2 = length-delimited
        writeVarint(tag)
        let utf8 = Array(value.utf8)
        writeVarint(UInt64(utf8.count))
        data.append(contentsOf: utf8)
    }

    mutating func writeBytesField(_ fieldNumber: Int, _ value: Data) {
        let tag = UInt64(fieldNumber << 3) | 2  // wire type 2 = length-delimited
        writeVarint(tag)
        writeVarint(UInt64(value.count))
        data.append(value)
    }

    /// Embed a sub-message (length-delimited)
    mutating func writeMessageField(_ fieldNumber: Int, _ subMessage: Data) {
        let tag = UInt64(fieldNumber << 3) | 2
        writeVarint(tag)
        writeVarint(UInt64(subMessage.count))
        data.append(subMessage)
    }

    mutating func writeBoolField(_ fieldNumber: Int, _ value: Bool) {
        writeInt32Field(fieldNumber, value ? 1 : 0)
    }
}

// MARK: - Minimal Protobuf Decoding Helpers

private struct ProtobufReader {
    private let data: Data
    private var offset: Int = 0

    init(_ data: Data) {
        self.data = data
    }

    var hasMore: Bool {
        offset < data.count
    }

    mutating func readVarint() -> UInt64? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while offset < data.count {
            let byte = data[data.startIndex + offset]
            offset += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
            if shift > 63 { return nil }
        }
        return nil
    }

    /// Returns (fieldNumber, wireType) or nil
    mutating func readTag() -> (Int, Int)? {
        guard let tag = readVarint() else { return nil }
        return (Int(tag >> 3), Int(tag & 0x07))
    }

    mutating func readInt32() -> Int32? {
        guard let v = readVarint() else { return nil }
        return Int32(truncatingIfNeeded: v)
    }

    mutating func readBytes() -> Data? {
        guard let len = readVarint() else { return nil }
        let length = Int(len)
        guard offset + length <= data.count else { return nil }
        let result = data[(data.startIndex + offset)..<(data.startIndex + offset + length)]
        offset += length
        return Data(result)
    }

    mutating func readString() -> String? {
        guard let bytes = readBytes() else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    /// Skip a field value based on wire type
    mutating func skipField(wireType: Int) {
        switch wireType {
        case 0: _ = readVarint()  // varint
        case 1: offset += 8  // 64-bit
        case 2: _ = readBytes()  // length-delimited
        case 5: offset += 4  // 32-bit
        default: break
        }
    }

    /// Parse a message into a dictionary of field# -> value
    /// Values are: Int32 for varint, Data for length-delimited
    mutating func parseFields() -> [Int: Any] {
        var fields: [Int: Any] = [:]
        while hasMore {
            guard let (fieldNum, wireType) = readTag() else { break }
            switch wireType {
            case 0:  // varint
                if let v = readVarint() { fields[fieldNum] = Int32(truncatingIfNeeded: v) }
            case 2:  // length-delimited (submessage or bytes or string)
                if let d = readBytes() { fields[fieldNum] = d }
            default:
                skipField(wireType: wireType)
            }
        }
        return fields
    }
}

// MARK: - EvenHub Protobuf Message Builders

private enum EvenHubProto {
    /// Build a TextContainerProperty message
    static func textContainerProperty(
        x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32 = 0, borderColor: Int32 = 0, borderRadius: Int32 = 0,
        paddingLength: Int32 = 0, containerID: Int32,
        containerName: String? = nil, isEventCapture: Bool = false,
        content: String? = nil
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, x)  // XPosition
        w.writeInt32Field(2, y)  // YPosition
        w.writeInt32Field(3, width)  // Width
        w.writeInt32Field(4, height)  // Height
        w.writeInt32Field(5, borderWidth)  // BorderWidth
        w.writeInt32Field(6, borderColor)  // BorderColor
        w.writeInt32Field(7, borderRadius)  // BorderRdaius (sic - typo in proto)
        w.writeInt32Field(8, paddingLength)  // PaddingLength
        w.writeInt32Field(9, containerID)  // ContainerID
        if let name = containerName {
            w.writeStringField(10, name)  // ContainerName
        }
        w.writeInt32Field(11, isEventCapture ? 1 : 0)  // IsEventCapture
        if let content = content {
            w.writeStringField(12, content)  // Content
        }
        return w.data
    }

    /// Build an ImageContainerProperty message
    static func imageContainerProperty(
        x: Int32, y: Int32, width: Int32, height: Int32,
        containerID: Int32, containerName: String? = nil
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, x)  // XPosition
        w.writeInt32Field(2, y)  // YPosition
        w.writeInt32Field(3, width)  // Width
        w.writeInt32Field(4, height)  // Height
        w.writeInt32Field(5, containerID)  // ContainerID
        if let name = containerName {
            w.writeStringField(6, name)  // ContainerName
        }
        return w.data
    }

    /// Build an ImageRawDataUpdate message
    static func imageRawDataUpdate(
        containerID: Int32, containerName: String? = nil,
        mapSessionId: Int32, mapTotalSize: Int32, compressMode: Int32 = 0,
        mapFragmentIndex: Int32, mapFragmentPacketSize: Int32, mapRawData: Data
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, containerID)  // ContainerID
        if let name = containerName {
            w.writeStringField(2, name)  // ContainerName
        }
        w.writeInt32Field(3, mapSessionId)  // MapSessionId
        w.writeInt32Field(4, mapTotalSize)  // MapTotalSize
        w.writeInt32Field(5, compressMode)  // CompressMode
        w.writeInt32Field(6, mapFragmentIndex)  // MapFragmentIndex
        w.writeInt32Field(7, mapFragmentPacketSize)  // MapFragmentPacketSize
        w.writeBytesField(8, mapRawData)  // MapRawData
        return w.data
    }

    /// Build a CreateStartUpPageContainer message
    static func createStartupPageContainer(
        containerTotalNum: Int32,
        textContainers: [Data] = [],
        imageContainers: [Data] = []
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, containerTotalNum)  // ContainerTotalNum
        // field 2 = repeated ListContainerProperty ListObject (not used here)
        for tc in textContainers {
            w.writeMessageField(3, tc)  // field 3 = repeated TextObject
        }
        for ic in imageContainers {
            w.writeMessageField(4, ic)  // field 4 = repeated ImageObject
        }
        return w.data
    }

    /// Build a TextContainerUpgrade message
    static func textContainerUpgrade(
        containerID: Int32, contentOffset: Int32 = 0,
        contentLength: Int32, content: String
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, containerID)  // ContainerID
        w.writeInt32Field(3, contentOffset)  // ContentOffset
        w.writeInt32Field(4, contentLength)  // ContentLength
        w.writeStringField(5, content)  // Content
        return w.data
    }

    /// Build a ShutDownContaniner message (sic - typo in proto)
    static func shutdownContainer(exitMode: Int32 = 0) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, exitMode)  // exitMode
        return w.data
    }

    /// Build a HeartBeatPacket message
    static func heartbeatPacket(cnt: Int32 = 0) -> Data {
        var w = ProtobufWriter()
        if cnt != 0 {
            w.writeInt32Field(1, cnt)  // Cnt
        }
        return w.data
    }

    /// Build an AudioCtrCmd message
    static func audioCtrCmd(enable: Bool) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, enable ? 1 : 0)  // AudoFuncEn
        return w.data
    }

    /// Build an evenhub_main_msg_ctx wrapper
    /// appId: optional menu item appId to associate the page with (enables cmdId=17 selection events)
    static func evenHubMessage(
        cmd: EvenHubCmd, subFieldNumber: Int, subMessage: Data, magicRandom: Int32 = 0,
        appId: Int32? = nil
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, cmd.rawValue)  // Cmd (field 1, enum)
        w.writeInt32Field(2, magicRandom)  // MagicRandom (field 2)
        w.writeMessageField(subFieldNumber, subMessage)  // the actual command payload
        if let appId = appId {
            w.writeInt32Field(5, appId)  // Associate page with a menu item appId
        }
        return w.data
    }

    /// Convenience builders for full evenhub messages
    static func createPageMessage(
        textContainers: [Data] = [], imageContainers: [Data] = [], magicRandom: Int32 = 0,
        appId _: Int32? = nil
    ) -> Data {
        let total = Int32(textContainers.count + imageContainers.count)
        let createMsg = createStartupPageContainer(
            containerTotalNum: total,
            textContainers: textContainers,
            imageContainers: imageContainers
        )
        return evenHubMessage(
            cmd: .createStartupPage, subFieldNumber: 3, subMessage: createMsg,
            magicRandom: magicRandom, appId: nil
        )
    }

    // RebuildPageContainer: same structure as CreateStartUpPageContainer, but cmd=7, field 7
    static func rebuildPageMessage(
        textContainers: [Data] = [], imageContainers: [Data] = [], magicRandom: Int32 = 0,
        appId: Int32? = nil
    )
        -> Data
    {
        let total = Int32(textContainers.count + imageContainers.count)
        let rebuildMsg = createStartupPageContainer(
            containerTotalNum: total,
            textContainers: textContainers,
            imageContainers: imageContainers
        )
        return evenHubMessage(
            cmd: .rebuildPage, subFieldNumber: 7, subMessage: rebuildMsg, magicRandom: magicRandom,
            appId: appId
        )
    }

    static func updateImageRawDataMessage(
        containerID: Int32, containerName: String? = nil,
        mapSessionId: Int32, mapTotalSize: Int32, compressMode: Int32 = 0,
        mapFragmentIndex: Int32, mapFragmentPacketSize: Int32, mapRawData: Data
    ) -> Data {
        let updateMsg = imageRawDataUpdate(
            containerID: containerID, containerName: containerName,
            mapSessionId: mapSessionId, mapTotalSize: mapTotalSize,
            compressMode: compressMode,
            mapFragmentIndex: mapFragmentIndex,
            mapFragmentPacketSize: mapFragmentPacketSize,
            mapRawData: mapRawData
        )
        return evenHubMessage(cmd: .updateImageRawData, subFieldNumber: 5, subMessage: updateMsg)
    }

    static func updateTextMessage(
        containerID: Int32, contentOffset: Int32 = 0, contentLength: Int32, content: String
    ) -> Data {
        let upgradeMsg = textContainerUpgrade(
            containerID: containerID, contentOffset: contentOffset,
            contentLength: contentLength, content: content
        )
        return evenHubMessage(cmd: .updateTextData, subFieldNumber: 9, subMessage: upgradeMsg)
    }

    static func shutdownMessage(exitMode: Int32 = 0) -> Data {
        let shutdownMsg = shutdownContainer(exitMode: exitMode)
        return evenHubMessage(cmd: .shutdownPage, subFieldNumber: 11, subMessage: shutdownMsg)
    }

    static func heartbeatMessage(magicRandom: Int32 = 0) -> Data {
        let hbMsg = heartbeatPacket()
        return evenHubMessage(
            cmd: .heartbeat, subFieldNumber: 14, subMessage: hbMsg, magicRandom: magicRandom
        )
    }

    static func audioControlMessage(enable: Bool, magicRandom: Int32 = 0) -> Data {
        let audioMsg = audioCtrCmd(enable: enable)
        return evenHubMessage(
            cmd: .audioControl, subFieldNumber: 18, subMessage: audioMsg, magicRandom: magicRandom
        )
    }

    // MARK: - IMU control
    //
    // Wire format recovered by on-device brute-force (sample magnitude ≈ 1.0 g confirms
    // the decode). Shapes from even_hub_sdk@0.0.10; numeric proto tags confirmed live:
    //   EvenHub_Cmd_List IMU command = 19
    //   evenhub_main_msg_ctx ImuCtrlCmd slot = field 20
    //   ImuCtrlCmd { field 1 = IMU_ReportEn (bool), field 2 = reportFrq (pacing 100…1000) }
    //   Report path: cmd=2 (osNotifyEventToApp) → SendDeviceEvent.field13 →
    //                Sys_ItemEvent { field 1 = eventType = 8 (IMU_DATA_REPORT),
    //                                field 3 = imuData = IMU_Report_Data }
    //   IMU_Report_Data { field 1 = x, 2 = y, 3 = z } — each a 32-bit float (NOT double),
    //                     gravity-normalized (|v| ≈ 1 at rest).
    static let imuCtrlSubField = 20

    /// ImuReportPace pacing codes (protocol values, NOT literal Hz). Step 100, 100…1000.
    static let imuPaceP100: Int32 = 100
    static let imuPaceP500: Int32 = 500
    static let imuPaceP1000: Int32 = 1000

    /// Build an ImuCtrlCmd sub-message.
    static func imuCtrlCmd(enable: Bool, reportFrq: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, enable ? 1 : 0)  // IMU_ReportEn
        if enable {
            w.writeInt32Field(2, reportFrq)  // reportFrq (pacing code 100…1000)
        }
        return w.data
    }

    /// Build a full evenhub_main_msg_ctx that enables/disables IMU reporting.
    /// `reportFrq` is an ImuReportPace pacing code; ignored when disabling.
    static func imuControlMessage(
        enable: Bool, reportFrq: Int32 = imuPaceP100, magicRandom: Int32 = 0
    ) -> Data {
        let imuMsg = imuCtrlCmd(enable: enable, reportFrq: reportFrq)
        var w = ProtobufWriter()
        w.writeInt32Field(1, EvenHubCmd.imuControl.rawValue)  // Cmd
        w.writeInt32Field(2, magicRandom)  // MagicRandom
        w.writeMessageField(imuCtrlSubField, imuMsg)  // ImuCtrlCmd slot (field 20)
        return w.data
    }
}

// MARK: - DevSettings Auth Protobuf Builders

private enum DevSettingsProto {
    /// DevCfgDataPackage with AUTHENTICATION command
    static func authCmd(magicRandom: Int32) -> Data {
        // DevCfgDataPackage:
        //   field 1 = commandId (enum)
        //   field 2 = magicRandom (int32)
        //   field 3 = authMgr (AuthMgr message)
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.authentication.rawValue)  // commandId
        w.writeInt32Field(2, magicRandom)  // magicRandom

        // AuthMgr sub-message:
        //   field 1 = secAuth (bool)
        //   field 2 = phoneType (enum eDevice: PHONE_IOS=3, PHONE_ANDROID=4)
        var authW = ProtobufWriter()
        authW.writeBoolField(1, true)  // secAuth
        authW.writeInt32Field(2, 3)  // phoneType = PHONE_IOS (eDevice.PHONE_IOS=3)

        w.writeMessageField(3, authW.data)  // authMgr
        return w.data
    }

    /// DevCfgDataPackage with PIPE_ROLE_CHANGE command
    static func pipeRoleChange(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.pipeRoleChange.rawValue)
        w.writeInt32Field(2, magicRandom)

        // PipeRoleChange: field 1 = asCmdRole (enum GlassesLR.RIGHT=1)
        var roleW = ProtobufWriter()
        roleW.writeInt32Field(1, 1)  // RIGHT
        w.writeMessageField(4, roleW.data)  // roleChange (field 4 in DevCfgDataPackage)
        return w.data
    }

    /// DevCfgDataPackage with TIME_SYNC command.
    /// TimeSync submessage: f1 = (Unix seconds + TZ offset seconds) as Int32, no TZ field.
    /// Firmware appears to ignore the TZ field, so we pre-shift the timestamp itself
    /// to make UTC interpretation read as local. Empirically confirmed via probe variants in dbg1().
    static func timeSync(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.timeSync.rawValue)
        w.writeInt32Field(2, magicRandom)

        var tsW = ProtobufWriter()
        let nowSec = Int64(Date().timeIntervalSince1970)
        let tzSec = Int64(TimeZone.current.secondsFromGMT())
        tsW.writeInt32Field(1, Int32(truncatingIfNeeded: nowSec + tzSec))
        w.writeMessageField(128, tsW.data)  // timeSync (field 128 in DevCfgDataPackage)
        return w.data
    }

    /// Parameterized TIME_SYNC for probing the right wire format from dbg1().
    /// - tsField:   protobuf field # for the timestamp varint (typically 1)
    /// - tsValue:   raw timestamp varint value
    /// - tsBits64:  encode timestamp as Int64 (true) or Int32 (false)
    /// - tzField:   protobuf field # for TZ (nil to omit entirely)
    /// - tzValue:   TZ value to write if tzField != nil
    static func timeSyncVariant(
        magicRandom: Int32,
        tsField: Int, tsValue: Int64, tsBits64: Bool,
        tzField: Int?, tzValue: Int32
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.timeSync.rawValue)
        w.writeInt32Field(2, magicRandom)

        var tsW = ProtobufWriter()
        if tsBits64 {
            tsW.writeInt64Field(tsField, tsValue)
        } else {
            tsW.writeInt32Field(tsField, Int32(truncatingIfNeeded: tsValue))
        }
        if let tzField = tzField {
            tsW.writeInt32Field(tzField, tzValue)
        }
        w.writeMessageField(128, tsW.data)
        return w.data
    }

    /// DevCfgDataPackage with BASE_CONNECT_HEART_BEAT command
    static func baseHeartbeat(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.baseConnHeartBeat.rawValue)
        w.writeInt32Field(2, magicRandom)

        // BaseConnHeartBeat: empty message
        var hbW = ProtobufWriter()
        _ = hbW  // empty
        w.writeMessageField(13, hbW.data)  // baseHeartBeat (field 13)
        return w.data
    }

    /// DevCfgDataPackage with RING_CONNECT_INFO command
    /// Tells the glasses to connect/disconnect to a ring by MAC address.
    /// RingInfo: field 1 = connectRing (bool), field 2 = ringMac (bytes), field 3 = ringName (bytes)
    static func ringConnectInfo(
        magicRandom: Int32, connect: Bool, ringMac: Data, ringName: String = ""
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.ringConnectInfo.rawValue)  // commandId = RING_CONNECT_INFO (6)
        w.writeInt32Field(2, magicRandom)

        // RingInfo sub-message (field 5 in DevCfgDataPackage)
        var ringW = ProtobufWriter()
        ringW.writeBoolField(1, connect)  // connectRing
        ringW.writeBytesField(2, ringMac)  // ringMac (6 bytes)
        if !ringName.isEmpty {
            ringW.writeBytesField(3, Data(ringName.utf8))  // ringName
        }

        w.writeMessageField(5, ringW.data)  // ringInfo (field 5)
        return w.data
    }
}

// MARK: - G2 Settings Protobuf Builders (g2_setting.proto, service ID 9)

private enum G2SettingProto {
    /// Set brightness: G2SettingPackage with DeviceReceiveInfo + DeviceReceive_Brightness
    static func setBrightness(magicRandom: Int32, level: Int32, autoAdjust: Bool) -> Data {
        // DeviceReceive_Brightness
        var brightnessW = ProtobufWriter()
        brightnessW.writeInt32Field(1, autoAdjust ? 1 : 0)  // autoAdjust
        brightnessW.writeInt32Field(2, level)  // brightnessLevel

        // DeviceReceiveInfoFromAPP
        var infoW = ProtobufWriter()
        infoW.writeMessageField(1, brightnessW.data)  // deviceReceiveBrightness (field 1)

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveInfo.rawValue)  // commandId
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.data)  // deviceReceiveInfoFromApp (field 3)
        return w.data
    }

    /// Request battery/version/etc: G2SettingPackage with DeviceReceiveRequest
    static func requestInfo(magicRandom: Int32) -> Data {
        // DeviceReceiveRequestFromAPP - empty message triggers glasses to respond with all fields
        var reqW = ProtobufWriter()
        // Request brightness info type
        reqW.writeInt32Field(1, 1)  // settingInfoType = APP_REQUIRE_BASIC_SETTING

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveRequest.rawValue)  // commandId
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(4, reqW.data)  // deviceReceiveRequestFromApp (field 4)
        return w.data
    }

    /// Toggle head-up display on/off
    static func setHeadUpSwitch(magicRandom: Int32, enabled: Bool) -> Data {
        // DeviceReceive_Head_UP_Setting
        var headUpW = ProtobufWriter()
        headUpW.writeInt32Field(1, enabled ? 1 : 0)  // headUpSwitch

        // DeviceReceiveInfoFromAPP
        var infoW = ProtobufWriter()
        infoW.writeMessageField(4, headUpW.data)  // deviceReceiveHeadUpSetting (field 4)

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveInfo.rawValue)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.data)  // deviceReceiveInfoFromApp (field 3)
        return w.data
    }

    /// Set head-up trigger angle (0-60 degrees)
    static func setHeadUpAngle(magicRandom: Int32, angle: Int32) -> Data {
        // DeviceReceive_Head_UP_Setting
        var headUpW = ProtobufWriter()
        headUpW.writeInt32Field(2, angle)  // headUpAngle (field 2)

        // DeviceReceiveInfoFromAPP
        var infoW = ProtobufWriter()
        infoW.writeMessageField(4, headUpW.data)  // deviceReceiveHeadUpSetting (field 4)

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveInfo.rawValue)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.data)
        return w.data
    }

    /// Set screen height (Y coordinate level, 0-12)
    static func setScreenHeight(magicRandom: Int32, level: Int32) -> Data {
        // DeviceReceive_Y_Coordinate
        var yW = ProtobufWriter()
        yW.writeInt32Field(1, level)  // yCoordinateLevel

        // DeviceReceiveInfoFromAPP
        var infoW = ProtobufWriter()
        infoW.writeMessageField(2, yW.data)  // deviceReceiveYCoordinate (field 2)

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveInfo.rawValue)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.data)
        return w.data
    }

    /// Set screen depth (X coordinate level, 0-2)
    static func setScreenDepth(magicRandom: Int32, level: Int32) -> Data {
        // DeviceReceive_X_Coordinate
        var xW = ProtobufWriter()
        xW.writeInt32Field(1, level)  // xCoordinateLevel

        // DeviceReceiveInfoFromAPP
        var infoW = ProtobufWriter()
        infoW.writeMessageField(3, xW.data)  // deviceReceiveXCoordinate (field 3)

        // G2SettingPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.deviceReceiveInfo.rawValue)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.data)
        return w.data
    }
}

// MARK: - Onboarding Protobuf Builders (onboarding.proto, service ID 16)

private enum OnboardingProto {
    /// Skip onboarding: OnboardingDataPackage with CONFIG command, processId=FINISH
    static func skipOnboarding(magicRandom: Int32) -> Data {
        // OnboardingConfig: processId = FINISH (4)
        var configW = ProtobufWriter()
        configW.writeInt32Field(1, 4)  // processId = FINISH

        // OnboardingDataPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, 1)  // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, configW.data)  // config (field 3)
        return w.data
    }
}

// MARK: - EvenAI Protobuf Builders (even_ai.proto, service ID 7)

private enum EvenAIProto {
    /// EvenAIDataPackage with CONFIG command to toggle Hey Even wakeword.
    /// voiceSwitch: 0 = OFF, 1 = ON.
    ///
    /// Wire format confirmed by sniffing the official app toggling the setting:
    ///   EvenAIConfig (field 13) = { f1=voiceSwitch, f2=32 }
    /// The app OMITS f1 when disabling (proto3 zero) and sends f2=32 (0x20), NOT 80.
    /// Observed echoes: ON  → 6A04 08 01 10 20  ({f1:1, f2:32})
    ///                  OFF → 6A02 10 20         ({f2:32})
    static func setHeyEven(magicRandom: Int32, enabled: Bool) -> Data {
        // EvenAIConfig
        var configW = ProtobufWriter()
        if enabled {
            configW.writeInt32Field(1, 1)  // voiceSwitch (omitted when off, matching the app)
        }
        configW.writeInt32Field(2, 32)  // streamSpeed (always sent, app uses 32)

        // EvenAIDataPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, 10)  // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(13, configW.data)  // config (field 13)
        return w.data
    }

    /// EvenAIDataPackage with ASK command — what the phone sends after cloud
    /// ASR resolves the user's audio into text. Mirrors Flutter `sendAsr`:
    /// `EvenAIAskInfo { text, streamEnable=0 }`. Used to inject an ASR result
    /// into the glasses' AI session so the following SKILL packet has context.
    static func aiAsk(magicRandom: Int32, text: String, streamEnable: Int32 = 0) -> Data {
        var askW = ProtobufWriter()
        askW.writeInt32Field(2, streamEnable)  // streamEnable
        askW.writeBytesField(4, Data(text.utf8))  // text

        var w = ProtobufWriter()
        w.writeInt32Field(1, 3)  // commandId = ASK
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(5, askW.data)  // askInfo (field 5)
        return w.data
    }

    /// EvenAIDataPackage with CTRL command — used to put glasses into / out of
    /// an AI session. Mirrors Flutter `sendWakeupResp`, which sends
    /// `EvenAIControl { status = EVEN_AI_ENTER }` after the glasses send WAKE_UP.
    /// status: 1 WAKE_UP, 2 ENTER, 3 EXIT
    static func aiCtrl(magicRandom: Int32, status: Int32) -> Data {
        var ctrlW = ProtobufWriter()
        ctrlW.writeInt32Field(1, status)  // status

        var w = ProtobufWriter()
        w.writeInt32Field(1, 1)  // commandId = CTRL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, ctrlW.data)  // ctrl (field 3)
        return w.data
    }

    /// EvenAIDataPackage with SKILL command — triggers a built-in glasses UI
    /// the same way the "Hey Even, show X" voice command does.
    /// skillId values (per even_ai.proto):
    ///   0 SKILL_NONE, 1 BRIGHTNESS, 2 TRANSLATE_CTRL, 3 NOTIFICATION,
    ///   4 TELEPROMPT, 5 NAVIGATE, 6 CONVERSATE, 7 QUICKLIST, 8 AUTO_BRIGHTNESS
    static func triggerSkill(
        magicRandom: Int32, skillId: Int32, skillParam: Int32 = 0,
        text: String = "", streamEnable: Int32 = 1, fTextEnd: Int32 = 1
    ) -> Data {
        // EvenAISkillInfo
        var skillW = ProtobufWriter()
        skillW.writeInt32Field(1, streamEnable)  // streamEnable
        skillW.writeInt32Field(2, skillId)  // skillId
        skillW.writeInt32Field(3, skillParam)  // skillParam — for NOTIFICATION skill this is a NotificationType enum
        skillW.writeBytesField(4, Data(text.utf8))  // text (utterance / payload)
        skillW.writeInt32Field(6, fTextEnd)  // fTextEnd — 1 signals "this is the final/complete packet"

        // EvenAIDataPackage
        var w = ProtobufWriter()
        w.writeInt32Field(1, 6)  // commandId = SKILL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(8, skillW.data)  // skillInfo (field 8)
        return w.data
    }
}

// MARK: - Notification Protobuf Builders (notification.proto, service ID 4)

private enum NotificationProto {
    /// NotificationDataPackage with commandId=NOTIFICATION_IOS (2), carrying
    /// `NotificationIOS { appID, displayName }`. We saw the glasses emit this
    /// inbound after "Hey Even, show notifications" with appID="com.burbn.instagram";
    /// trying the same shape outbound to see if the glasses display it.
    /// (Returned errorCode=8 NOT_SUPPORT in testing — Service 4 doesn't accept this outbound.)
    static func iosNotification(magicRandom: Int32, appID: String, displayName: String) -> Data {
        var iosW = ProtobufWriter()
        iosW.writeBytesField(1, Data(appID.utf8))  // appID
        iosW.writeBytesField(2, Data(displayName.utf8))  // displayName

        var w = ProtobufWriter()
        w.writeInt32Field(1, 2)  // commandId = NOTIFICATION_IOS
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(4, iosW.data)  // IOS (field 4)
        return w.data
    }

    /// NotificationDataPackage with commandId=NOTIFICATION_CTRL (1), carrying
    /// `NotificationControl { notifEnable, autoDispEnable, dispTime, avoidDisturbEnable }`.
    /// Per Flutter `ProtoNotificationExt.settingNotification` this is how the
    /// official app configures notification behavior on the glasses. Worth
    /// testing whether toggling notifEnable also opens the notification panel.
    static func notificationCtrl(
        magicRandom: Int32,
        notifEnable: Int32 = 1,
        autoDispEnable: Int32 = 1,
        dispTime: Int32 = 5,
        avoidDisturbEnable: Int32 = 0
    ) -> Data {
        var ctrlW = ProtobufWriter()
        ctrlW.writeInt32Field(1, notifEnable)  // notifEnable
        ctrlW.writeInt32Field(2, autoDispEnable)  // autoDispEnable
        ctrlW.writeInt32Field(3, dispTime)  // dispTime (seconds)
        ctrlW.writeInt32Field(5, avoidDisturbEnable)  // avoidDisturbEnable

        var w = ProtobufWriter()
        w.writeInt32Field(1, 1)  // commandId = NOTIFICATION_CTRL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, ctrlW.data)  // ctrl (field 3)
        return w.data
    }
}

// MARK: - Menu Protobuf Builders (menu.proto, service ID 3)

private enum MenuProto {
    /// Input from RN — packageName + display name + running state
    struct MenuItem {
        let packageName: String
        let name: String
        let running: Bool
    }

    /// G2 firmware requires minimum 5, maximum 10 menu items
    static let MIN_MENU_SIZE = 5
    static let MAX_MENU_SIZE = 10
    static let MAX_NAME_LENGTH = 15  // 17 char limit minus 2 for running indicator prefix
    /// Placeholder appIds for padding slots (in valid Even range, unique per slot)
    static let PLACEHOLDER_APP_IDS: [Int32] = [10535, 10536, 10537, 10538, 10539]

    /// Deterministic hash of packageName → numeric appId in range 10029–10534
    /// Even's third-party appIds are all in the 10029–10539 range
    static func packageNameToAppId(_ packageName: String) -> Int32 {
        var hash: Int32 = 0
        for char in packageName.unicodeScalars {
            hash = ((hash &<< 5) &- hash) &+ Int32(char.value)
        }
        // 506 values: 10029–10534 (reserve 10535–10539 for placeholders)
        return 10029 + (abs(hash) % 506)
    }

    /// meun_main_msg_ctx with APP_SEND_MENU_INFO command
    /// Handles: name truncation (15 chars), running prefix ("● " / "  "), padding to 5, cap at 10
    /// Returns (protobuf data, appId→packageName mapping for reverse lookup)
    /// meun_main_msg_ctx with APP_SEND_MENU_INFO command
    /// Handles: name truncation (15 chars), running prefix ("● " / "  "), padding to 5, cap at 10
    /// Always prepends the built-in Notification item as the first entry.
    /// Returns (protobuf data, appId→packageName mapping for reverse lookup)
    static func sendMenuInfo(magicRandom: Int32, items: [MenuItem]) -> (Data, [Int32: String]) {
        var appIdMap: [Int32: String] = [:]

        // Wire items carry either a built-in (itemType=0, no name) or third-party (itemType=1, with name)
        struct WireItem {
            let displayName: String?  // nil for built-ins
            let appId: Int32
            let isBuiltIn: Bool
        }

        var wireItems: [WireItem] = []

        // Always first: built-in Notification (SID=4)
        wireItems.append(WireItem(displayName: nil, appId: 4, isBuiltIn: true))

        // Third-party items — leave room for the built-in
        for item in items.prefix(MAX_MENU_SIZE - 1) {
            let appId = packageNameToAppId(item.packageName)
            appIdMap[appId] = item.packageName

            let truncated =
                item.name.count > MAX_NAME_LENGTH
                ? String(item.name.prefix(MAX_NAME_LENGTH))
                : item.name
            let prefix = item.running ? "● " : ""
            wireItems.append(
                WireItem(displayName: prefix + truncated, appId: appId, isBuiltIn: false)
            )
        }

        // Pad to MIN_MENU_SIZE with placeholder third-party items
        while wireItems.count < MIN_MENU_SIZE {
            let idx = wireItems.count - 1  // -1 because built-in occupies slot 0
            wireItems.append(
                WireItem(
                    displayName: "  ---",
                    appId: PLACEHOLDER_APP_IDS[idx],
                    isBuiltIn: false
                )
            )
        }

        // MenuInfoSend
        var menuW = ProtobufWriter()
        menuW.writeInt32Field(1, Int32(wireItems.count))  // itemTotalNum

        for item in wireItems {
            var itemW = ProtobufWriter()
            if item.isBuiltIn {
                itemW.writeInt32Field(1, 0)  // itemType = 0 (built-in)
                itemW.writeInt32Field(4, item.appId)  // itemAppId = SID
            } else {
                itemW.writeInt32Field(1, 1)  // itemType = 1 (third-party)
                itemW.writeInt32Field(2, 1)  // iconNum = 1
                itemW.writeStringField(3, item.displayName ?? "")  // itemName
                itemW.writeInt32Field(4, item.appId)  // itemAppId
            }
            menuW.writeMessageField(2, itemW.data)  // repeated item (field 2)
        }

        // meun_main_msg_ctx
        var w = ProtobufWriter()
        w.writeInt32Field(1, 0)  // Cmd = APP_SEND_MENU_INFO (0)
        w.writeInt32Field(2, magicRandom)  // MagicRandom
        w.writeMessageField(3, menuW.data)  // sendData (field 3)
        return (w.data, appIdMap)
    }
}

// MARK: - Dashboard Protobuf Builders (dashboard.proto, service ID 1)

/// Builders for the dashboard widget service (service 0x01).
/// Field numbers come from the extracted dashboard.proto v2.1.0_beta_v3.
private enum DashboardProto {
    /// eDashboardCommandId values from dashboard.proto
    enum CommandId: Int32 {
        case dashboardRespond = 1
        case dashboardReceive = 2  // phone → glasses widget/config push
        case appRespond = 3
        case appReceive = 4
    }

    /// Build a Schedule submessage (the calendar event payload).
    ///   f1 = scheduleId (int32, required)
    ///   f2 = title (string, optional)
    ///   f3 = location (string, optional)
    ///   f4 = time (string, optional — display text e.g. "10:00 AM")
    ///   f5 = endTimestamp (int32, presumed Unix seconds — pre-shift by TZ
    ///        to match the time-sync hack so glasses display local time)
    static func schedule(
        scheduleId: Int32,
        title: String?,
        location: String?,
        time: String?,
        endTimestamp: Int32
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, scheduleId)
        if let title = title { w.writeStringField(2, title) }
        if let location = location { w.writeStringField(3, location) }
        if let time = time { w.writeStringField(4, time) }
        w.writeInt32Field(5, endTimestamp)
        return w.data
    }

    /// Build an rScheduleWidget wrapping a single Schedule.
    ///   f1 = scheduleTotal, f2 = scheduleNum (0-based), f3 = Schedule, f4 = scheduleAuthority
    static func rScheduleWidget(
        scheduleTotal: Int32,
        scheduleNum: Int32,
        schedule: Data,
        scheduleAuthority: Int32
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, scheduleTotal)
        w.writeInt32Field(2, scheduleNum)
        w.writeMessageField(3, schedule)
        w.writeInt32Field(4, scheduleAuthority)
        return w.data
    }

    /// Build the full calendar-push DashboardDataPackage:
    ///   DashboardDataPackage {
    ///     commandId = Dashboard_Receive (2)
    ///     magicRandom
    ///     dashboardReceive = DashboardReceiveFromApp {
    ///       packageId = 1
    ///       bashboardConfig = DashboardContent {
    ///         widgetComponents = rWidgetComponent {
    ///           schedule = rScheduleWidget { ... }
    ///         }
    ///       }
    ///     }
    ///   }
    static func calendarPush(
        magicRandom: Int32,
        packageId: Int32,
        scheduleId: Int32,
        title: String?,
        location: String?,
        time: String?,
        endTimestamp: Int32,
        scheduleAuthority: Int32,
        scheduleTotal: Int32 = 1,
        scheduleNum: Int32 = 0
    ) -> Data {
        let sched = schedule(
            scheduleId: scheduleId, title: title, location: location,
            time: time, endTimestamp: endTimestamp
        )
        let rSched = rScheduleWidget(
            scheduleTotal: scheduleTotal, scheduleNum: scheduleNum,
            schedule: sched, scheduleAuthority: scheduleAuthority
        )

        // rWidgetComponent { f3 = rScheduleWidget }
        var rWidget = ProtobufWriter()
        rWidget.writeMessageField(3, rSched)

        // DashboardContent { f2 = rWidgetComponent }
        var content = ProtobufWriter()
        content.writeMessageField(2, rWidget.data)

        // DashboardReceiveFromApp { f1 = packageId, f3 = DashboardContent }
        var receive = ProtobufWriter()
        receive.writeInt32Field(1, packageId)
        receive.writeMessageField(3, content.data)

        // DashboardDataPackage { f1 = commandId, f2 = magicRandom, f4 = dashboardReceive }
        var pkg = ProtobufWriter()
        pkg.writeInt32Field(1, CommandId.dashboardReceive.rawValue)
        pkg.writeInt32Field(2, magicRandom)
        pkg.writeMessageField(4, receive.data)
        return pkg.data
    }

    static func calendarClear(
        magicRandom: Int32,
        packageId: Int32,
        scheduleAuthority: Int32
    ) -> Data {
        // rScheduleWidget with scheduleTotal=0 clears the widget without sending a stale Schedule.
        var rSched = ProtobufWriter()
        rSched.writeInt32Field(1, 0)
        rSched.writeInt32Field(2, 0)
        rSched.writeInt32Field(4, scheduleAuthority)

        var rWidget = ProtobufWriter()
        rWidget.writeMessageField(3, rSched.data)

        var content = ProtobufWriter()
        content.writeMessageField(2, rWidget.data)

        var receive = ProtobufWriter()
        receive.writeInt32Field(1, packageId)
        receive.writeMessageField(3, content.data)

        var pkg = ProtobufWriter()
        pkg.writeInt32Field(1, CommandId.dashboardReceive.rawValue)
        pkg.writeInt32Field(2, magicRandom)
        pkg.writeMessageField(4, receive.data)
        return pkg.data
    }
}

// MARK: - EvenBLE Transport Layer

/// Builds and splits payloads into BLE packets with the EvenHub transport framing
private struct EvenBLETransport {
    var syncId: UInt8

    /// Build one or more framed packets for a payload
    static func buildPackets(
        syncId: UInt8, serviceId: UInt8, payload: Data, reserveFlag: Bool = false
    ) -> [Data] {
        let maxPayload = G2BLE.MAX_PACKET_PAYLOAD

        // Split payload into chunks
        var chunks: [Data] = []
        var offset = 0
        while offset < payload.count {
            let end = min(offset + maxPayload, payload.count)
            chunks.append(payload[offset..<end])
            offset = end
        }
        if chunks.isEmpty {
            chunks.append(Data())
        }

        // If last chunk is exactly max size, we need an extra packet for CRC
        let needExtraCrcPacket = (chunks.last!.count == maxPayload)
        if needExtraCrcPacket {
            chunks.append(Data())
        }

        let totalPackets = UInt8(chunks.count)
        let crc = calcCRC16(payload)

        var packets: [Data] = []
        for (i, chunk) in chunks.enumerated() {
            let serialNum = UInt8(i + 1)
            let isLast = (serialNum == totalPackets)

            // status byte: bit0=notify, bits1-4=resultCode, bit5=reserveFlag, bits6-7=reserve
            let status: UInt8 = (reserveFlag ? 0x20 : 0x00)

            // payload length includes CRC if last packet
            let payloadLen = UInt8(chunk.count + (isLast ? 2 : 0))

            var packet = Data()
            packet.append(G2BLE.HEADER_BYTE)  // [0] 0xAA
            packet.append((G2BLE.DEST_GLASSES << 4) | G2BLE.SOURCE_PHONE)  // [1] src+dst
            packet.append(syncId)  // [2] syncId
            packet.append(payloadLen)  // [3] payloadLen
            packet.append(totalPackets)  // [4] packetTotalNum
            packet.append(serialNum)  // [5] packetSerialNum
            packet.append(serviceId)  // [6] serviceId
            packet.append(status)  // [7] status

            packet.append(chunk)

            if isLast {
                packet.append(UInt8(crc & 0xFF))  // CRC low
                packet.append(UInt8((crc >> 8) & 0xFF))  // CRC high
            }

            packets.append(packet)
        }

        return packets
    }
}

// MARK: - G2 Send Manager

/// Manages syncId counter and sends packets over BLE
private class G2SendManager {
    private var syncId: UInt8 = 0
    private var magicRandom: UInt8 = 0

    func nextSyncId() -> UInt8 {
        let id = syncId
        syncId = syncId &+ 1
        return id
    }

    func nextMagicRandom() -> Int32 {
        let val = magicRandom
        magicRandom = magicRandom &+ 1
        return Int32(val)
    }

    func buildPackets(serviceId: UInt8, payload: Data, reserveFlag: Bool = false) -> [Data] {
        let sid = nextSyncId()
        return EvenBLETransport.buildPackets(
            syncId: sid, serviceId: serviceId, payload: payload, reserveFlag: reserveFlag
        )
    }
}

// MARK: - G2 Receive Manager (multi-part reassembly)

private class G2ReceiveManager {
    private var partials: [String: (Data, UInt8)] = [:]  // key -> (accumulated payload, lastSerialNum)

    func handlePacket(_ rawData: Data, sourceKey: String = "") -> (serviceId: UInt8, payload: Data)?
    {
        guard rawData.count >= 8 else { return nil }
        guard rawData[0] == G2BLE.HEADER_BYTE else { return nil }

        let payloadLen = Int(rawData[3])
        let expectedLen = payloadLen + 8
        guard rawData.count >= expectedLen else { return nil }

        let totalPackets = rawData[4]
        let serialNum = rawData[5]
        let serviceId = rawData[6]
        let status = rawData[7]
        let resultCode = (status >> 1) & 0x0F

        guard resultCode == 0 else { return nil }

        let isLast = (serialNum == totalPackets)
        let hasCrc = isLast
        let payloadEnd = 8 + payloadLen - (hasCrc ? 2 : 0)
        let payload = rawData[8..<payloadEnd]

        let syncId = rawData[2]
        // Key partials by source peripheral too — left and right glasses have independent syncId counters
        let key = "\(sourceKey)-\(serviceId)-\(syncId)"

        if serialNum > 1 {
            guard var existing = partials[key] else { return nil }
            existing.0.append(payload)
            existing.1 = serialNum
            partials[key] = existing
        } else if totalPackets > 1 {
            partials[key] = (Data(payload), serialNum)
        }

        if !isLast {
            if serialNum == 1 && totalPackets > 1 {
                // Already stored above
            }
            return nil
        }

        let fullPayload: Data
        if let existing = partials[key] {
            var accumulated = existing.0
            if serialNum > 1 {
                // already appended above
            } else {
                accumulated.append(payload)
            }
            fullPayload = accumulated
            partials.removeValue(forKey: key)
        } else {
            fullPayload = Data(payload)
        }

        return (serviceId, fullPayload)
    }
}

// MARK: - G2 Class (SGCManager implementation)

/// Actor for reconnection logic (matches G1 pattern)
actor G2ReconnectionManager {
    private var task: Task<Void, Never>?
    private let intervalSeconds: TimeInterval
    private var attempts = 0
    private let maxAttempts: Int  // -1 for unlimited

    init(intervalSeconds: TimeInterval = 30, maxAttempts: Int = -1) {
        self.intervalSeconds = intervalSeconds
        self.maxAttempts = maxAttempts
    }

    var isRunning: Bool {
        task != nil && task?.isCancelled == false
    }

    func start(onAttempt: @escaping @Sendable () async -> Bool) {
        stop()
        attempts = 0

        task = Task {
            while !Task.isCancelled {
                if maxAttempts > 0, attempts >= maxAttempts {
                    Bridge.log("G2: Max reconnection attempts (\(maxAttempts)) reached")
                    break
                }

                attempts += 1
                Bridge.log("G2: Reconnection attempt \(attempts)")

                let shouldStop = await onAttempt()

                if shouldStop {
                    Bridge.log("G2: Reconnection successful, stopping")
                    break
                }

                do {
                    try await Task.sleep(nanoseconds: UInt64(intervalSeconds * 1_000_000_000))
                } catch {
                    break
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        attempts = 0
    }
}

@MainActor
class G2: NSObject, SGCManager {
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}

    var type = DeviceTypes.G2
    let hasMic = true

    /// Connection state
    private var connectionState: String = ConnTypes.DISCONNECTED

    // BLE peripherals (L+R)
    private var centralManager: CBCentralManager?
    private var leftPeripheral: CBPeripheral?
    private var rightPeripheral: CBPeripheral?
    private var leftWriteChar: CBCharacteristic?
    private var rightWriteChar: CBCharacteristic?
    private var leftNotifyChar: CBCharacteristic?
    private var rightNotifyChar: CBCharacteristic?
    private var rightAudioChar: CBCharacteristic?
    private var leftAudioChar: CBCharacteristic?
    private var leftInitialized: Bool = false
    private var rightInitialized: Bool = false
    private var leftAuthenticated: Bool = false
    private var rightAuthenticated: Bool = false
    private var isDisconnecting = false
    private var pairingTimeoutTimer: DispatchWorkItem?
    private var useEvenDashboard = true
    private var dashboardShowing = 0

    /// Device search
    var DEVICE_SEARCH_ID = "NOT_SET"
    /// map device names to serial numbers:
    private var deviceNameToSerialNumber: [String: String] = [:]

    /// Stored UUIDs per serial number for background reconnection.
    /// Maps serial number -> peripheral UUID string. Persisted across forget() so previously
    /// paired devices can reconnect quickly without a fresh scan.
    private var leftGlassUUIDMap: [String: String] {
        get {
            UserDefaults.standard.dictionary(forKey: "g2_leftGlassUUIDMap") as? [String: String]
                ?? [:]
        }
        set { UserDefaults.standard.set(newValue, forKey: "g2_leftGlassUUIDMap") }
    }

    private var rightGlassUUIDMap: [String: String] {
        get {
            UserDefaults.standard.dictionary(forKey: "g2_rightGlassUUIDMap") as? [String: String]
                ?? [:]
        }
        set { UserDefaults.standard.set(newValue, forKey: "g2_rightGlassUUIDMap") }
    }

    private func leftGlassUUID(forSN sn: String) -> UUID? {
        return leftGlassUUIDMap[sn].flatMap { UUID(uuidString: $0) }
    }

    private func rightGlassUUID(forSN sn: String) -> UUID? {
        return rightGlassUUIDMap[sn].flatMap { UUID(uuidString: $0) }
    }

    private func setLeftGlassUUID(_ uuid: UUID, forSN sn: String) {
        var m = leftGlassUUIDMap
        m[sn] = uuid.uuidString
        leftGlassUUIDMap = m
    }

    private func setRightGlassUUID(_ uuid: UUID, forSN sn: String) {
        var m = rightGlassUUIDMap
        m[sn] = uuid.uuidString
        rightGlassUUIDMap = m
    }

    /// Reconnection
    private let reconnectionManager = G2ReconnectionManager()

    // Protocol state
    private let sendManager = G2SendManager()
    private let receiveManager = G2ReceiveManager()
    private var foregroundObserver: NSObjectProtocol?
    private var startupPageCreated: Bool = false  // createStartUpPageContainer can only be called once
    private var pageCreated: Bool = false
    private var currentTextContent: String = ""
    private var currentBitmapBase64: String = ""
    private var textContainerID: Int32 = 1
    private var imageSessionCounter: Int = 0
    private var heartbeatTask: Task<Void, Never>?
    private var heartbeatCounter: Int = 0
    private var evenHubQueueTask: Task<Void, Never>?
    private var pendingTextMsg: Data?
    private var lastEvenHubMsg: Data?
    private var lastEvenHubResendsRemaining: Int = 0
    private let EVEN_HUB_RESEND_COUNT: Int = 1
    private let evenHubQueueLock = NSLock()
    private var authStarted: Bool = false

    /// Dashboard menu: appId → packageName mapping for selection reverse lookup
    private var menuAppIdToPackageName: [Int32: String] = [:]
    /// Dashboard menu items (stored for re-send on connect)
    private var dashboardMenuItems: [MenuProto.MenuItem] = []
    /// Current appId to associate EvenHub pages with (enables menu selection events)
    /// Set to the first menu item's appId so glasses know our page belongs to the menu
    private var activeMenuAppId: Int32?
    private var lastClickTimestamp: Int64?
    private var lastEvenHubResponseTimestamp: Int64?
    private var lastMenuSelectTimestamp: Int64?
    private var lastGestureCtrlTimestamp: Int64?

    /// A tracked image container on the current page. Keyed by its rect for reuse.
    private struct ImgContainer: Equatable {
        let id: Int32
        let x: Int32
        let y: Int32
        let width: Int32
        let height: Int32
        var name: String {
            "img-\(id)"
        }
        var bmpData: Data

        func matches(x: Int32, y: Int32, width: Int32, height: Int32) -> Bool {
            self.x == x && self.y == y && self.width == width && self.height == height
        }
    }

    private struct TextContainer: Equatable {
        let id: Int32
        let x: Int32
        let y: Int32
        let width: Int32
        let height: Int32
        var content: String
        let borderWidth: Int32
        let borderColor: Int32
        let borderRadius: Int32
        let paddingLength: Int32
        var name: String {
            "text-\(id)"
        }

        func matches(
            x: Int32, y: Int32, width: Int32, height: Int32, borderWidth: Int32, borderColor: Int32,
            borderRadius: Int32, paddingLength: Int32
        ) -> Bool {
            self.x == x && self.y == y && self.width == width && self.height == height
                && self.borderWidth == borderWidth && self.borderColor == borderColor
                && self.borderRadius == borderRadius && self.paddingLength == paddingLength
        }
    }

    /// Live list of image containers on the page, ordered oldest→newest (for LRU eviction).
    /// The page may hold at most 4 image containers (IDs from the pool below).
    private var imageContainers: [ImgContainer] = []
    private var textContainers: [TextContainer] = []
    /// Fixed pool of container IDs the page protocol expects.
    private let imageContainerIDPool: [Int32] = [10, 11, 12, 13]
    private let textContainerIDPool: [Int32] = [1, 2, 3, 4, 5, 6]
    private static let defaultImgContainer = (
        x: Int32(188), y: Int32(44), width: Int32(200), height: Int32(100)
    )
    private static let defaultTextContainer = (
        x: Int32(0), y: Int32(0), width: Int32(576), height: Int32(288), borderWidth: Int32(0),
        borderColor: Int32(0), borderRadius: Int32(0), paddingLength: Int32(4)
    )

    @Published var aiListening: Bool = false

    static let _bluetoothQueue = DispatchQueue(label: "BluetoothG2", qos: .userInitiated)

    // MARK: - Initialization

    override init() {
        super.init()
    }

    deinit {
        if let observer = foregroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        centralManager?.delegate = nil
        leftPeripheral?.delegate = nil
        rightPeripheral?.delegate = nil
    }

    // MARK: - BLE Sending

    private func sendToGlasses(_ packets: [Data], left: Bool = false, right: Bool = true) {
        // Bridge.log("G2: sendToGlasses() - sending \(packets.count) packets first byte: \(packets[0][0])")
        for packet in packets {
            if right, let char = rightWriteChar, let peripheral = rightPeripheral {
                peripheral.writeValue(packet, for: char, type: .withoutResponse)
            }
            if left, let char = leftWriteChar, let peripheral = leftPeripheral {
                peripheral.writeValue(packet, for: char, type: .withoutResponse)
            }
        }
    }

    private func sendEvenHubCommand(_ payload: Data, left: Bool = false, right: Bool = true) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.evenHub.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets, left: left, right: right)
    }

    private func sendDevSettingsCommand(_ payload: Data, left: Bool = false, right: Bool = true) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.deviceSettings.rawValue,
            payload: payload
        )
        sendToGlasses(packets, left: left, right: right)
    }

    private func sendNavigationCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.navigation.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendG2SettingCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.g2Setting.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendOnboardingCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.onboarding.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendEvenAICommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.evenAI.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendNotificationCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.notification.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendMenuCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.menu.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendGestureCtrlCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.gestureCtrl.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendEvenHubCtrlCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.evenHubCtrl.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets)
    }

    private func sendDashboardCommand(_ payload: Data) {
        let packets = sendManager.buildPackets(
            serviceId: ServiceID.dashboard.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendToGlasses(packets, left: true, right: true)
    }

    // MARK: - Authentication Sequence

    private func authLeft() {
        // Auth to left side
        if leftPeripheral != nil && leftWriteChar != nil {
            let authL = DevSettingsProto.authCmd(magicRandom: sendManager.nextMagicRandom())
            sendDevSettingsCommand(authL, left: true, right: false)
        }
    }

    private func authRight() {
        let authR = DevSettingsProto.authCmd(magicRandom: sendManager.nextMagicRandom())
        sendDevSettingsCommand(authR, left: false, right: true)
    }

    private func runAuthSequence() async {
        Bridge.log("G2: Running auth sequence")

        // Auth to left side
        if leftPeripheral != nil && leftWriteChar != nil {
            let authL = DevSettingsProto.authCmd(magicRandom: sendManager.nextMagicRandom())
            sendDevSettingsCommand(authL, left: true, right: false)
        }

        // Small delay then auth right + pipe role change + time sync
        try? await Task.sleep(nanoseconds: 200_000_000)

        let authR = DevSettingsProto.authCmd(magicRandom: self.sendManager.nextMagicRandom())
        self.sendDevSettingsCommand(authR, left: false, right: true)

        try? await Task.sleep(nanoseconds: 200_000_000)

        let roleChange = DevSettingsProto.pipeRoleChange(
            magicRandom: self.sendManager.nextMagicRandom()
        )
        self.sendDevSettingsCommand(roleChange, left: false, right: true)

        try? await Task.sleep(nanoseconds: 200_000_000)

        let timeSync = DevSettingsProto.timeSync(
            magicRandom: self.sendManager.nextMagicRandom()
        )
        self.sendDevSettingsCommand(timeSync)

        // Skip onboarding on connect
        try? await Task.sleep(nanoseconds: 200_000_000)
        let onboarding = OnboardingProto.skipOnboarding(
            magicRandom: self.sendManager.nextMagicRandom()
        )
        self.sendOnboardingCommand(onboarding)
        Bridge.log("G2: Sent onboarding skip (FINISH)")

        // 1. gesture_ctrl init (field1=0, field2=magicRandom)
        var gestureInitW = ProtobufWriter()
        gestureInitW.writeInt32Field(1, 0)
        gestureInitW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        self.sendGestureCtrlCommand(gestureInitW.data)

        // 2. ui_setting_app (0x0C) — query (cmd=2, field4={settingInfoType=1, autoBrightnessLevel=0})
        var uiSettW = ProtobufWriter()
        uiSettW.writeInt32Field(1, 2)  // cmd = DeviceReceiveRequest
        uiSettW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        uiSettW.writeMessageField(4, Data([0x08, 0x01, 0x10, 0x00]))  // {1:1, 2:0}
        self.sendToGlasses(
            self.sendManager.buildPackets(
                serviceId: 0x0C, payload: uiSettW.data, reserveFlag: true
            )
        )

        // 6. Dashboard init (0x01) — display settings
        // halfDayFormat: 1 = 12h, 0 = 24h
        // temperatureUnit: 1 = Celsius (metric), 2 = Fahrenheit (imperial)
        var dashDisplayW = ProtobufWriter()
        dashDisplayW.writeInt32Field(1, 4)  // displayMode
        dashDisplayW.writeInt32Field(2, 3)  // statusDisplayCount
        dashDisplayW.writeMessageField(3, Data([1, 2, 3]))  // statusDisplayOrder
        dashDisplayW.writeInt32Field(4, 4)  // widgetDisplayCount
        // WidgetType: 1=News, 2=Stock, 3=Schedule, 4=Quicklist, 5=Health
        dashDisplayW.writeMessageField(5, Data([3, 1, 2, 4, 5]))  // widgetDisplayOrder: Schedule, News, Stock, Quicklist
        dashDisplayW.writeInt32Field(6, self.dashboardHalfDayFormat())  // halfDayFormat
        dashDisplayW.writeInt32Field(7, self.dashboardTemperatureUnit())  // temperatureUnit

        var dashRecvW = ProtobufWriter()
        dashRecvW.writeMessageField(2, dashDisplayW.data)

        var dashPkgW = ProtobufWriter()
        dashPkgW.writeInt32Field(1, 2)  // Dashboard_Receive
        dashPkgW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        dashPkgW.writeMessageField(4, dashRecvW.data)
        self.sendDashboardCommand(dashPkgW.data)

        // Disable "Hey Even" wakeword on connect
        let heyEvenOff = EvenAIProto.setHeyEven(
            magicRandom: self.sendManager.nextMagicRandom(),
            enabled: false
        )
        self.sendEvenAICommand(heyEvenOff)
        Bridge.log("G2: Disabled Hey Even wakeword")

        // 7. Dashboard REQUEST_NEWS_INFO (cmd=5, field7={1:1})
        // var dashNewsReqW = ProtobufWriter()
        // dashNewsReqW.writeInt32Field(1, 5) // REQUEST_NEWS_INFO
        // dashNewsReqW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        // dashNewsReqW.writeMessageField(7, Data([0x08, 0x01])) // {1:1}
        // self.sendDashboardCommand(dashNewsReqW.data)

        // // 8. Gesture control list via g2_setting
        // var gestListW = ProtobufWriter()
        // gestListW.writeInt32Field(1, 1) // DeviceReceiveInfo
        // gestListW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        // // field 3 with field 10 (gestureControlList): 3 items, all app_unable
        // let gestureCtrlPayload = Data([
        //     0x52, 0x18, // field 10, length 24
        //     0x0A, 0x06, 0x08, 0x00, 0x10, 0x00, 0x18, 0x00, // item 1
        //     0x0A, 0x06, 0x08, 0x00, 0x10, 0x01, 0x18, 0x00, // item 2
        //     0x0A, 0x06, 0x08, 0x00, 0x10, 0x02, 0x18, 0x00, // item 3
        // ])
        // gestListW.writeMessageField(3, gestureCtrlPayload)
        // self.sendG2SettingCommand(gestListW.data)

        // // 9. Dashboard APP_REQUEST_NEWS_INFO (cmd=7, field9={1:1})
        // var dashAppNewsW = ProtobufWriter()
        // dashAppNewsW.writeInt32Field(1, 7) // APP_REQUEST_NEWS_INFO
        // dashAppNewsW.writeInt32Field(2, self.sendManager.nextMagicRandom())
        // dashAppNewsW.writeMessageField(9, Data([0x08, 0x01])) // {1:1}
        // self.sendDashboardCommand(dashAppNewsW.data)

        Bridge.log("G2: Sent full Even-compatible init sequence")

        // Start heartbeats after auth
        self.startHeartbeats()

        Task { await self.reconnectionManager.stop() }
        Bridge.log("G2: Auth sequence complete, glasses ready")

        // Set device_name so DeviceManager can save it for reconnection
        if let peripheralName = self.rightPeripheral?.name
            ?? self.leftPeripheral?.name,
            let serialNumber = self.deviceNameToSerialNumber[peripheralName]
        {
            DeviceStore.shared.apply("bluetooth", "device_name", serialNumber)
            Bridge.log("G2: Set device_name to \(serialNumber)")
        }

        // Set bluetooth name and device model for Device Info page
        let btName =
            self.rightPeripheral?.name
            ?? self.leftPeripheral?.name ?? ""
        DeviceStore.shared.apply("glasses", "bluetoothName", btName)
        DeviceStore.shared.apply("glasses", "deviceModel", DeviceTypes.G2)

        self.setFullyConnected()

        // connnect a controller if we have one:
        self.connectController()

        // Query version + battery info from glasses
        self.requestDeviceInfo()

        // send dashboard menu if we have stored items
        self.sendMenuApps()

        // order the calendar (Schedule) widget first on the dashboard
        self.setCalendarWidgetFirst()

        // send calendar events
        let calendarEvents =
            DeviceStore.shared.get("bluetooth", "calendar_events") as? [[String: Any]] ?? []
        self.sendCalendarEvents(calendarEvents)
    }

    // MARK: - Heartbeats

    private func startHeartbeats() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled else { break }
                await MainActor.run {
                    self?.sendEvenHubHeartbeat()
                    self?.sendDevSettingsHeartbeat()
                }
            }
        }

        // EvenHub text command queue: drain the most recent pending updateText every 100ms
        evenHubQueueTask?.cancel()
        evenHubQueueTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else { break }
                await MainActor.run {
                    self?.drainEvenHubQueue()
                }
            }
        }
    }

    private func stopHeartbeats() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        evenHubQueueTask?.cancel()
        evenHubQueueTask = nil
        evenHubQueueLock.lock()
        pendingTextMsg = nil
        lastEvenHubMsg = nil
        lastEvenHubResendsRemaining = 0
        evenHubQueueLock.unlock()
    }

    private func sendEvenHubHeartbeat() {
        let isFullyBooted = DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
        guard isFullyBooted else { return }

        let msg = EvenHubProto.heartbeatMessage()
        // Write to BOTH arms. If either side sees no traffic for ~50s while
        // backgrounded, iOS bluetoothd reclaims the connection as "Unused"
        // (disconnect reason 722) and tears down the link.
        sendEvenHubCommand(msg, left: true, right: true)

        // Poll battery every 10 heartbeats (~50 seconds)
        heartbeatCounter += 1
        if heartbeatCounter % 10 == 0 {
            requestDeviceInfo()
        }
    }

    private func sendDevSettingsHeartbeat() {
        let isFullyBooted = DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
        guard isFullyBooted else { return }
        let msg = DevSettingsProto.baseHeartbeat(magicRandom: sendManager.nextMagicRandom())
        sendDevSettingsCommand(msg, left: true, right: true)
    }

    /// Request battery, version, and other device info via g2_setting service
    private func requestDeviceInfo() {
        let msg = G2SettingProto.requestInfo(magicRandom: sendManager.nextMagicRandom())
        sendG2SettingCommand(msg)
        // Bridge.log("G2: Requested device info (battery/version)")
    }

    private func sendMenuApps() {
        let menuItems = DeviceStore.shared.get("bluetooth", "menu_apps") as? [[String: Any]] ?? []
        if menuItems.isEmpty {
            return
        }
        setDashboardMenu(menuItems)
    }

    // MARK: - SGCManager: Display Control

    func sendTextWall(_ text: String) async {
        await sendTextAt(
            text,
            x: G2.defaultTextContainer.x,
            y: G2.defaultTextContainer.y,
            width: G2.defaultTextContainer.width,
            height: G2.defaultTextContainer.height,
            borderWidth: G2.defaultTextContainer.borderWidth,
            borderColor: G2.defaultTextContainer.borderColor,
            borderRadius: G2.defaultTextContainer.borderRadius,
            paddingLength: G2.defaultTextContainer.paddingLength
        )
    }

    // Protocol witness for SGCManager.sendText — G2 renders a simple string as a
    // default-positioned text wall. The positioned variant is `sendTextAt`.
    func sendText(_ text: String) async {
        await sendTextWall(text)
    }

    func sendTextAt(
        _ text: String, x: Int32? = nil, y: Int32? = nil, width: Int32? = nil, height: Int32? = nil,
        borderWidth: Int32? = nil, borderColor: Int32? = nil, borderRadius: Int32? = nil,
        paddingLength: Int32? = nil
    ) async {
        // Bridge.log("G2: sendTextWall(\(text.prefix(50))...)")

        // ignore events while the ER dashboard is open:
        let useNativeDashboard =
            DeviceStore.shared.get("bluetooth", "use_native_dashboard") as? Bool ?? false
        if useNativeDashboard && dashboardShowing > 0 {
            return
        }

        let rx = x ?? G2.defaultTextContainer.x
        let ry = y ?? G2.defaultTextContainer.y
        let rw = width ?? G2.defaultTextContainer.width
        let rh = height ?? G2.defaultTextContainer.height
        let borderWidth = G2.defaultTextContainer.borderWidth
        let borderColor = G2.defaultTextContainer.borderColor
        let borderRadius = G2.defaultTextContainer.borderRadius
        let paddingLength = G2.defaultTextContainer.paddingLength
        let content = text.isEmpty ? " " : text

        // Reuse an existing container if the rect matches exactly; otherwise add a new one.
        var container: TextContainer
        if let i = textContainers.firstIndex(where: {
            $0.matches(
                x: rx, y: ry, width: rw, height: rh, borderWidth: borderWidth,
                borderColor: borderColor, borderRadius: borderRadius, paddingLength: paddingLength)
        }) {
            textContainers[i].content = content
            container = textContainers[i]
            Bridge.log(
                "G2: sendText() - reusing container \(container.id) for rect \(rx),\(ry) \(rw)x\(rh)"
            )
            if !pageCreated {
                await rebuildPage()
                return
            }
            let msg = EvenHubProto.updateTextMessage(
                containerID: container.id,
                contentOffset: 0,
                contentLength: Int32(container.content.utf8.count),
                content: container.content
            )
            queueEvenHubCommand(msg)
            return
        }

        container = addTextContainer(
            x: rx, y: ry, width: rw, height: rh, content: content, borderWidth: borderWidth,
            borderColor: borderColor, borderRadius: borderRadius, paddingLength: paddingLength)
        Bridge.log(
            "G2: sendText() - added text container \(container.id) for rect \(rx),\(ry) \(rw)x\(rh), rebuilding page"
        )
        await rebuildPage()
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        Bridge.log("G2: sendDoubleTextWall() - top: \(top), bottom: \(bottom)")
        // G2 doesn't have native double text wall, combine them
        let combined = top + "\n\n" + bottom
        await sendTextWall(combined)
    }

    func clearDisplay() {
        Bridge.log("G2: clearDisplay()")
        // Don't shutdown the EvenHub page — that kills audio streaming too.
        // Instead, just clear the text content by sending a space.

        // if !pageCreated {
        //     Bridge.log("G2: clearDisplay() - page not created")
        //     createPageWithContainers()
        // }

        // reset the content of all text containers to empty:
        for i in textContainers.indices {
            textContainers[i].content = " "
        }
        for i in imageContainers.indices {
            imageContainers[i].bmpData = Data()
        }
        // shutdown the page and then recreate the containers without the content:
        Task { await rebuildPage() }
    }

    /// Send BMP data to an image container via fragmented updateImageRawData
    private func sendImageData(containerID: Int32, containerName: String, bmpData: Data) async {
        let fragmentSize = 4096
        imageSessionCounter += 1
        let sessionId = imageSessionCounter
        let totalSize = Int32(bmpData.count)
        var fragmentIndex: Int32 = 0
        var offset = 0

        Bridge.log(
            "G2: sendImageData(\(containerName)) - \(fragmentIndex) fragments, \(bmpData.count) bytes"
        )

        while offset < bmpData.count {
            let end = min(offset + fragmentSize, bmpData.count)
            let fragment = bmpData[offset..<end]

            let msg = EvenHubProto.updateImageRawDataMessage(
                containerID: containerID,
                containerName: containerName,
                mapSessionId: Int32(sessionId),
                mapTotalSize: totalSize,
                compressMode: 0,
                mapFragmentIndex: fragmentIndex,
                mapFragmentPacketSize: Int32(fragment.count),
                mapRawData: Data(fragment)
            )
            sendEvenHubCommand(msg)

            fragmentIndex += 1
            offset = end
            try? await Task.sleep(nanoseconds: 200_000_000)  // 200ms between fragments
        }
    }

    /// Display a bitmap inside a positioned image container.
    ///
    /// The page keeps a live list of up to 4 image containers keyed by exact rect:
    ///  - If a container with the requested rect already exists, the image is just resent to it
    ///    (no page rebuild).
    ///  - Otherwise a new container is added (evicting the oldest when the list would exceed 4) and
    ///    the page is rebuilt before the image is sent.
    ///
    /// Omitted params default to a 100x100 container in the top-left corner.
    func displayBitmap(
        base64ImageData: String, x: Int32? = nil, y: Int32? = nil, width: Int32? = nil,
        height: Int32? = nil
    ) async -> Bool {
        let rx = x ?? G2.defaultImgContainer.x
        let ry = y ?? G2.defaultImgContainer.y
        let rw = width ?? G2.defaultImgContainer.width
        let rh = height ?? G2.defaultImgContainer.height

        // ignore events while the ER dashboard is open:
        let useNativeDashboard =
            DeviceStore.shared.get("bluetooth", "use_native_dashboard") as? Bool ?? false
        if useNativeDashboard && dashboardShowing > 0 {
            return false
        }

        guard let rawData = Data(base64Encoded: base64ImageData) else {
            Bridge.log("G2: failed to decode base64")
            return false
        }

        guard
            let bmpData = convertToG2Bmp(rawData, containerWidth: Int(rw), containerHeight: Int(rh))
        else {
            Bridge.log("G2: failed to convert image to BMP")
            return false
        }

        // Reuse an existing container if the rect matches exactly; otherwise add a new one.
        var container: ImgContainer
        if let i = imageContainers.firstIndex(where: {
            $0.matches(x: rx, y: ry, width: rw, height: rh)
        }) {
            imageContainers[i].bmpData = bmpData
            container = imageContainers[i]
            Bridge.log(
                "G2: displayBitmap() - reusing container \(container.id) for rect \(rx),\(ry) \(rw)x\(rh)"
            )
            if !pageCreated {
                await rebuildPage()
                return true
            }
            await sendImageData(
                containerID: container.id, containerName: container.name, bmpData: container.bmpData
            )
            return true
        } else {
            container = addImageContainer(x: rx, y: ry, width: rw, height: rh, bmpData: bmpData)
            Bridge.log(
                "G2: displayBitmap() - added container \(container.id) for rect \(rx),\(ry) \(rw)x\(rh), rebuilding page"
            )
            await rebuildPage()
        }
        return true
    }

    /// Add a new image container for `rect`, evicting the oldest when the list is full (max 4).
    /// Returns the newly tracked container (with an assigned ID from the pool).
    private func addImageContainer(x: Int32, y: Int32, width: Int32, height: Int32, bmpData: Data)
        -> ImgContainer
    {
        // Evict the oldest container when at capacity, freeing its ID for reuse.
        if imageContainers.count >= imageContainerIDPool.count {
            let evicted = imageContainers.removeFirst()
            Bridge.log("G2: evicting oldest image container \(evicted.id)")
        }
        // Pick the lowest free ID from the pool.
        let usedIDs = Set(imageContainers.map { $0.id })
        let id = imageContainerIDPool.first { !usedIDs.contains($0) } ?? imageContainerIDPool[0]
        let container = ImgContainer(
            id: id, x: x, y: y, width: width, height: height, bmpData: bmpData)
        imageContainers.append(container)
        return container
    }

    private func addTextContainer(
        x: Int32, y: Int32, width: Int32, height: Int32, content: String, borderWidth: Int32,
        borderColor: Int32, borderRadius: Int32, paddingLength: Int32
    ) -> TextContainer {
        // Evict the oldest container when at capacity, freeing its ID for reuse.
        if textContainers.count >= textContainerIDPool.count {
            let evicted = textContainers.removeFirst()
            Bridge.log("G2: evicting oldest text container \(evicted.id)")
        }
        // Pick the lowest free ID from the pool.
        let usedIDs = Set(textContainers.map { $0.id })
        let id = textContainerIDPool.first { !usedIDs.contains($0) } ?? textContainerIDPool[0]
        let container = TextContainer(
            id: id, x: x, y: y, width: width, height: height, content: content,
            borderWidth: borderWidth, borderColor: borderColor, borderRadius: borderRadius,
            paddingLength: paddingLength)
        textContainers.append(container)
        return container
    }

    /// shutdown and rebuild everything, re-sends all data to the glasses:
    private func rebuildPage() async {
        let msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        await rebuildState()
    }

    // re-creates the containers and sends all images and text again to the glasses:
    private func rebuildState() async {
        Bridge.log("G2: rebuildState()")
        // recreate the containers:
        createPageWithContainers()

        try? await Task.sleep(nanoseconds: 300_000_000)  // 300ms to settle
        // send any image containers we have
        // go through each container and send the data:
        for container in imageContainers {
            Bridge.log(
                "G2: rebuildState() - sending image data to container \(container.id), \(container.bmpData.count) bytes"
            )
            await sendImageData(
                containerID: container.id, containerName: container.name, bmpData: container.bmpData
            )
            try? await Task.sleep(nanoseconds: 300_000_000)  // 300ms between containers
        }

        // go through each text container and send the data:
        // disabled because text containers are initialized with their content:
        // for container in textContainers {
        //     let msg = EvenHubProto.updateTextMessage(
        //         containerID: container.id,
        //         contentOffset: 0,
        //         contentLength: Int32(container.content.utf8.count),
        //         content: container.content
        //     )
        //     sendEvenHubCommand(msg)
        // }
        
        try? await Task.sleep(nanoseconds: 300_000_000)  // 300ms to settle
        restartMicIfAlreadyEnabled()
    }

    /// Upscale BMP pixel data by 2x (200x100 → 400x200) using nearest-neighbor
    private func upscaleBmp2x(_ bmpData: Data, srcWidth: Int, srcHeight: Int) -> Data? {
        // Parse the BMP to extract pixel data, then rebuild at 2x
        // BMP header: 14 bytes file header + 40 bytes DIB header + 64 bytes color table = 118 bytes
        let headerSize = 14 + 40 + 64
        guard bmpData.count > headerSize else {
            Bridge.log("G2: upscaleBmp2x - BMP too small")
            return nil
        }

        let srcPaddedRowSize = ((srcWidth + 1) / 2 + 3) & ~3  // 4-bit rows padded to 4 bytes
        let pixelDataOffset = headerSize

        let dstWidth = srcWidth * 2
        let dstHeight = srcHeight * 2
        let dstBytesPerRow = (dstWidth + 1) / 2
        let dstPaddedRowSize = (dstBytesPerRow + 3) & ~3
        let dstPixelDataSize = dstPaddedRowSize * dstHeight
        let dstFileSize = headerSize + dstPixelDataSize

        var dst = Data(capacity: dstFileSize)

        // --- BMP File Header (14 bytes) ---
        dst.append(contentsOf: [0x42, 0x4D])
        dst.appendLittleEndian(UInt32(dstFileSize))
        dst.appendLittleEndian(UInt16(0))
        dst.appendLittleEndian(UInt16(0))
        dst.appendLittleEndian(UInt32(headerSize))

        // --- DIB Header (40 bytes) ---
        dst.appendLittleEndian(UInt32(40))
        dst.appendLittleEndian(Int32(dstWidth))
        dst.appendLittleEndian(Int32(dstHeight))
        dst.appendLittleEndian(UInt16(1))
        dst.appendLittleEndian(UInt16(4))
        dst.appendLittleEndian(UInt32(0))
        dst.appendLittleEndian(UInt32(dstPixelDataSize))
        dst.appendLittleEndian(Int32(2835))
        dst.appendLittleEndian(Int32(2835))
        dst.appendLittleEndian(UInt32(16))
        dst.appendLittleEndian(UInt32(0))

        // --- Color Table (same 16-entry grayscale) ---
        for i in 0..<16 {
            let val = UInt8(i * 17)
            dst.append(contentsOf: [val, val, val, 0])
        }

        // --- Pixel Data (nearest-neighbor 2x upscale) ---
        // BMP is bottom-up, so row 0 = bottom of image
        // Each dst row maps to srcRow = dstRow / 2
        for dstRow in 0..<dstHeight {
            let srcRow = dstRow / 2
            let srcRowOffset = pixelDataOffset + srcRow * srcPaddedRowSize
            var rowBuf = [UInt8](repeating: 0, count: dstPaddedRowSize)

            for dstCol in 0..<dstWidth {
                let srcCol = dstCol / 2

                // Read 4-bit nibble from source
                let srcBytePos = srcRowOffset + srcCol / 2
                guard srcBytePos < bmpData.count else { continue }
                let srcByte = bmpData[srcBytePos]
                let nibble: UInt8 = (srcCol % 2 == 0) ? (srcByte >> 4) : (srcByte & 0x0F)

                // Write 4-bit nibble to destination
                let dstBytePos = dstCol / 2
                if dstCol % 2 == 0 {
                    rowBuf[dstBytePos] = nibble << 4
                } else {
                    rowBuf[dstBytePos] |= nibble
                }
            }
            dst.append(contentsOf: rowBuf)
        }

        Bridge.log(
            "G2: upscaleBmp2x - \(srcWidth)x\(srcHeight) → \(dstWidth)x\(dstHeight), \(dst.count) bytes"
        )
        return dst
    }

    // MARK: - Bitmap Conversion

    /// Scale source image to fit within containerWidth x containerHeight (maintaining aspect ratio),
    /// centered on a black background. Output BMP always matches container dimensions exactly.
    private func convertToG2Bmp(_ data: Data, containerWidth: Int, containerHeight: Int) -> Data? {
        guard let image = UIImage(data: data), let cgImage = image.cgImage else {
            Bridge.log("G2: convertToG2Bmp - could not decode image")
            return nil
        }

        let srcWidth = cgImage.width
        let srcHeight = cgImage.height

        // Scale to fit within container (maintain aspect ratio)
        let scale = min(
            Double(containerWidth) / Double(srcWidth), Double(containerHeight) / Double(srcHeight)
        )
        let scaledW = max(1, Int(Double(srcWidth) * scale))
        let scaledH = max(1, Int(Double(srcHeight) * scale))
        // Center within container
        let offsetX = (containerWidth - scaledW) / 2
        let offsetY = (containerHeight - scaledH) / 2

        // Bridge.log(
        //     "G2: convertToG2Bmp - input \(srcWidth)x\(srcHeight) → scaled \(scaledW)x\(scaledH) in \(containerWidth)x\(containerHeight)"
        // )

        // Render to 8-bit grayscale at the CONTAINER size (not scaled size)
        guard
            let ctx = CGContext(
                data: nil,
                width: containerWidth,
                height: containerHeight,
                bitsPerComponent: 8,
                bytesPerRow: containerWidth,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        else {
            Bridge.log("G2: convertToG2Bmp - failed to create CGContext")
            return nil
        }

        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: containerWidth, height: containerHeight))
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: offsetX, y: offsetY, width: scaledW, height: scaledH))

        guard let renderedImage = ctx.makeImage(),
            let pixels = renderedImage.dataProvider?.data as Data?
        else {
            Bridge.log("G2: convertToG2Bmp - failed to get pixel data")
            return nil
        }

        guard
            let bmp = build4BitBmp(
                grayscalePixels: pixels, width: containerWidth, height: containerHeight
            )
        else {
            Bridge.log("G2: convertToG2Bmp - failed to build BMP")
            return nil
        }

        return bmp
    }

    /// Build a 4-bit indexed BMP file from 8-bit grayscale pixel data.
    /// BMP rows are stored bottom-up. Each row is padded to a 4-byte boundary.
    private func build4BitBmp(grayscalePixels: Data, width: Int, height: Int) -> Data? {
        // 4-bit: 2 pixels per byte, rows padded to 4-byte boundary
        let bytesPerRow4bit = (width + 1) / 2  // ceil(width / 2)
        let paddedRowSize = (bytesPerRow4bit + 3) & ~3  // pad to 4-byte boundary
        let pixelDataSize = paddedRowSize * height

        // BMP file header (14 bytes) + DIB header (40 bytes) + color table (16 * 4 = 64 bytes)
        let headerSize = 14 + 40 + 64
        let fileSize = headerSize + pixelDataSize

        var bmp = Data(capacity: fileSize)

        // --- BMP File Header (14 bytes) ---
        bmp.append(contentsOf: [0x42, 0x4D])  // "BM" signature
        bmp.appendLittleEndian(UInt32(fileSize))  // File size
        bmp.appendLittleEndian(UInt16(0))  // Reserved1
        bmp.appendLittleEndian(UInt16(0))  // Reserved2
        bmp.appendLittleEndian(UInt32(headerSize))  // Pixel data offset

        // --- DIB Header (BITMAPINFOHEADER, 40 bytes) ---
        bmp.appendLittleEndian(UInt32(40))  // DIB header size
        bmp.appendLittleEndian(Int32(width))  // Width
        bmp.appendLittleEndian(Int32(height))  // Height (positive = bottom-up)
        bmp.appendLittleEndian(UInt16(1))  // Color planes
        bmp.appendLittleEndian(UInt16(4))  // Bits per pixel (4-bit)
        bmp.appendLittleEndian(UInt32(0))  // Compression (none)
        bmp.appendLittleEndian(UInt32(pixelDataSize))  // Image size
        bmp.appendLittleEndian(Int32(2835))  // X pixels/meter (~72 DPI)
        bmp.appendLittleEndian(Int32(2835))  // Y pixels/meter
        bmp.appendLittleEndian(UInt32(16))  // Colors used
        bmp.appendLittleEndian(UInt32(0))  // Important colors (0 = all)

        // --- Color Table (16 entries, 4 bytes each: B, G, R, 0) ---
        for i in 0..<16 {
            let val = UInt8(i * 17)  // 0, 17, 34, ... 255 (evenly spaced grayscale)
            bmp.append(contentsOf: [val, val, val, 0])  // B, G, R, Reserved
        }

        // --- Pixel Data (bottom-up rows, 4-bit packed) ---
        let rowBytes = [UInt8](repeating: 0, count: paddedRowSize)
        for row in 0..<height {
            // BMP is bottom-up: row 0 in BMP = last row of image
            let srcRow = height - 1 - row
            let srcOffset = srcRow * width
            var rowBuf = rowBytes

            for col in 0..<width {
                let pixelIndex = srcOffset + col
                guard pixelIndex < grayscalePixels.count else { continue }

                // Map 8-bit grayscale (0-255) to 4-bit index (0-15)
                let gray8 = grayscalePixels[pixelIndex]
                let index4 = gray8 >> 4  // divide by 16

                let bytePos = col / 2
                if col % 2 == 0 {
                    // High nibble
                    rowBuf[bytePos] = index4 << 4
                } else {
                    // Low nibble
                    rowBuf[bytePos] |= index4
                }
            }
            bmp.append(contentsOf: rowBuf)
        }

        // Bridge.log(
        //     "G2: build4BitBmp - \(bmp.count) bytes (header=\(headerSize), pixels=\(pixelDataSize), rows=\(paddedRowSize)x\(height))"
        // )
        return bmp
    }

    /// Bring the Even Realities dashboard (the OS-level home/idle screen) to
    /// the foreground by tearing down whatever EvenHub page we currently own.
    /// The glasses fall back to the dashboard automatically when no page is up.
    func showDashboard() {
        Bridge.log("G2: showDashboard()")
        dashboardShowing += 2
        let msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        currentBitmapBase64 = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            // activate the dashboard by setting dept to the current setting:
            let currentDepth = DeviceStore.shared.get("bluetooth", "dashboard_depth") as? Int ?? 0
            self.setDashboardDepthOnly(currentDepth)
        }
    }

    private func dashboardHalfDayFormat() -> Int32 {
        let twelveHour = DeviceStore.shared.get("bluetooth", "twelve_hour_time") as? Bool ?? true
        return twelveHour ? 1 : 0
    }

    private func dashboardTemperatureUnit() -> Int32 {
        let metric = DeviceStore.shared.get("bluetooth", "metric_system") as? Bool ?? false
        return metric ? 1 : 2
    }

    func sendDashboardDisplaySettings() {
        var dashDisplayW = ProtobufWriter()
        dashDisplayW.writeInt32Field(1, 4)  // displayMode
        dashDisplayW.writeInt32Field(2, 3)  // statusDisplayCount
        dashDisplayW.writeMessageField(3, Data([1, 2, 3]))  // statusDisplayOrder
        dashDisplayW.writeInt32Field(4, 4)  // widgetDisplayCount
        // WidgetType: 1=News, 2=Stock, 3=Schedule, 4=Quicklist, 5=Health
        dashDisplayW.writeMessageField(5, Data([3, 1, 2, 4, 5]))
        dashDisplayW.writeInt32Field(6, dashboardHalfDayFormat())  // halfDayFormat
        dashDisplayW.writeInt32Field(7, dashboardTemperatureUnit())  // temperatureUnit

        var dashRecvW = ProtobufWriter()
        dashRecvW.writeMessageField(2, dashDisplayW.data)

        var dashPkgW = ProtobufWriter()
        dashPkgW.writeInt32Field(1, 2)  // Dashboard_Receive
        dashPkgW.writeInt32Field(2, sendManager.nextMagicRandom())
        dashPkgW.writeMessageField(4, dashRecvW.data)
        sendDashboardCommand(dashPkgW.data)
    }

    /// Push a calendar event to the dashboard's Schedule widget (service 0x01).
    ///
    /// - title: event title displayed on the widget
    /// - location: optional location string
    /// - time: pre-formatted display string (e.g. "10:00 AM" or "10:00 – 10:30").
    ///         The widget shows this verbatim — format it however you want it to read.
    /// - endDate: when the event ends. Encoded the same way as the time-sync hack:
    ///         Unix seconds with the local TZ offset folded in, so the glasses (which
    ///         appear to treat timestamps as already-local) read it correctly.
    /// - scheduleId: stable per-event id. Reuse the same id when updating an event.
    func sendCalendarEvent(
        title: String,
        location: String? = nil,
        time: String? = nil,
        endDate: Date,
        scheduleId: Int32 = 1,
        scheduleTotal: Int32 = 1,
        scheduleNum: Int32 = 0
    ) {
        Bridge.log("G2: sendCalendarEvent(\(title), endDate=\(endDate))")
        let tzSec = Int64(TimeZone.current.secondsFromGMT())
        let endTs = Int32(truncatingIfNeeded: Int64(endDate.timeIntervalSince1970) + tzSec)

        let payload = DashboardProto.calendarPush(
            magicRandom: sendManager.nextMagicRandom(),
            packageId: 1,
            scheduleId: scheduleId,
            title: title,
            location: location,
            time: time,
            endTimestamp: endTs,
            scheduleAuthority: 1,
            scheduleTotal: scheduleTotal,
            scheduleNum: scheduleNum
        )
        sendDashboardCommand(payload)
    }

    /// Bridge entry for `calendar_events` store updates. Each dict is expected
    /// to match the TS `CalendarEvent` shape: { title, location?, time, endDate }
    /// where endDate is unix seconds.
    ///
    /// Sends one BLE push per event, with `scheduleTotal` set to the batch size
    /// and `scheduleNum` set to this event's 0-based slot. The widget pages
    /// through them on the glasses — without paging info the firmware overwrites
    /// slot 0 on each push and only the last event survives.
    func sendCalendarEvents(_ events: [[String: Any]]) {
        Bridge.log("G2: sendCalendarEvents — \(events.count) events")
        if events.isEmpty {
            let payload = DashboardProto.calendarClear(
                magicRandom: sendManager.nextMagicRandom(),
                packageId: 1,
                scheduleAuthority: 1
            )
            sendDashboardCommand(payload)
            return
        }

        let total = Int32(events.count)
        for (i, ev) in events.enumerated() {
            guard let title = ev["title"] as? String,
                let time = ev["time"] as? String,
                let endTs = ev["endDate"] as? Double
            else { continue }
            let location = ev["location"] as? String
            sendCalendarEvent(
                title: title,
                location: location,
                time: time,
                endDate: Date(timeIntervalSince1970: endTs),
                scheduleId: Int32(i + 1),
                scheduleTotal: total,
                scheduleNum: Int32(i)
            )
        }
    }

    func setDashboardPosition(_ height: Int, _ depth: Int) {
        Bridge.log("G2: setDashboardPosition(height=\(height), depth=\(depth))")
        setDashboardHeightOnly(height)
        setDashboardDepthOnly(depth)
    }

    func setDashboardHeightOnly(_ height: Int) {
        let clamped = Int32(min(max(height, 0), 12))
        Bridge.log("G2: setDashboardHeightOnly(\(clamped))")
        let msg = G2SettingProto.setScreenHeight(
            magicRandom: sendManager.nextMagicRandom(),
            level: clamped
        )
        sendG2SettingCommand(msg)
    }

    func setDashboardDepthOnly(_ depth: Int) {
        let clamped = Int32(min(max(depth, 0), 2))
        Bridge.log("G2: setDashboardDepthOnly(\(clamped))")
        let msg = G2SettingProto.setScreenDepth(
            magicRandom: sendManager.nextMagicRandom(),
            level: clamped
        )
        sendG2SettingCommand(msg)
    }

    func setBrightness(_ level: Int, autoMode: Bool) {
        Bridge.log("G2: setBrightness(\(level), auto=\(autoMode))")
        let msg = G2SettingProto.setBrightness(
            magicRandom: sendManager.nextMagicRandom(),
            level: Int32(level),
            autoAdjust: autoMode
        )
        sendG2SettingCommand(msg)
    }

    // MARK: - Private Display Helpers

    private func createPageWithContainers() {
        // build the page's text containers from the live tracked list.
        // iterate by index not using map:
        var textContainerProps: [Data] = []
        for (index, c) in textContainers.enumerated() {
            textContainerProps.append(
                EvenHubProto.textContainerProperty(
                    x: c.x, y: c.y, width: c.width, height: c.height,
                    borderWidth: c.borderWidth, borderColor: c.borderColor,
                    borderRadius: c.borderRadius,
                    paddingLength: c.paddingLength, containerID: c.id,
                    containerName: c.name, isEventCapture: index == 0,  // the first container is the event capture container
                    content: c.content
                ))
        }

        // iterate all image containers, remove any entrys with duplicate id's, and ensure the ids in the imageContainerIDPool is up-to-date:
        var seenIDs = Set<Int32>()
        imageContainers = imageContainers.filter { c in
            guard !c.bmpData.isEmpty else {
                Bridge.log("G2: removing empty image container \(c.id)")
                return false
            }
            guard !seenIDs.contains(c.id) else {
                Bridge.log("G2: removing duplicate image container \(c.id)")
                return false
            }
            seenIDs.insert(c.id)
            return imageContainerIDPool.contains(c.id)
        }

        // Build the page's image containers from the live tracked list.
        let imageContainerProps: [Data] = imageContainers.map { c in
            EvenHubProto.imageContainerProperty(
                x: c.x, y: c.y, width: c.width, height: c.height,
                containerID: c.id, containerName: c.name
            )
        }

        let msg: Data
        if !pageCreated {
            Bridge.log("G2: createPageWithContainers() - using createPageMessage (first time)")
            msg = EvenHubProto.createPageMessage(
                textContainers: textContainerProps,
                imageContainers: imageContainerProps,
                magicRandom: sendManager.nextMagicRandom(),
                appId: activeMenuAppId
            )
        } else {
            Bridge.log("G2: createPageWithContainers() - using rebuildPageMessage")
            msg = EvenHubProto.rebuildPageMessage(
                textContainers: textContainerProps,
                imageContainers: imageContainerProps,
                magicRandom: sendManager.nextMagicRandom(),
                appId: activeMenuAppId
            )
        }
        sendEvenHubCommand(msg)
        pageCreated = true
    }

    private func queueEvenHubCommand(_ payload: Data) {
        evenHubQueueLock.lock()
        pendingTextMsg = payload
        evenHubQueueLock.unlock()
    }

    private func drainEvenHubQueue() {
        evenHubQueueLock.lock()
        let msg = pendingTextMsg
        pendingTextMsg = nil
        let toSend: Data?
        if let msg = msg {
            lastEvenHubMsg = msg
            lastEvenHubResendsRemaining = EVEN_HUB_RESEND_COUNT
            toSend = msg
        } else if lastEvenHubResendsRemaining > 0, let last = lastEvenHubMsg {
            lastEvenHubResendsRemaining -= 1
            toSend = last
        } else {
            toSend = nil
        }
        evenHubQueueLock.unlock()
        guard let toSend = toSend else { return }
        sendEvenHubCommand(toSend)
    }

    private func restartMicIfAlreadyEnabled() {
        let currentEnabled = DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
        if currentEnabled {
            restartMic()
        }
    }

    func restartMic() {
        // if already enabled, set to disabled, then send enabled after 500ms:
        DeviceStore.shared.apply("glasses", "micEnabled", true)
        let msg = EvenHubProto.audioControlMessage(enable: false)
        sendEvenHubCommand(msg)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            let useNativeDashboard =
                DeviceStore.shared.get("bluetooth", "use_native_dashboard") as? Bool ?? false
            // Bridge.log("G2: setMicEnabled - useNativeDashboard=\(useNativeDashboard), dashboardShowing=\(dashboardShowing)")
            if useNativeDashboard && dashboardShowing > 0 {
                return
            }
            if !pageCreated {
                DeviceManager.shared.sendCurrentState()  // should re-create the page if needed
            }
            let msg = EvenHubProto.audioControlMessage(enable: true)
            self.sendEvenHubCommand(msg)
        }
    }

    // MARK: - SGCManager: Audio Control

    func setMicEnabled(_ enabled: Bool) {
        Bridge.log("G2: setMicEnabled(\(enabled))")
        let currentEnabled = DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
        if currentEnabled && enabled {
            restartMic()
            return
        }

        DeviceStore.shared.apply("glasses", "micEnabled", enabled)
        let msg = EvenHubProto.audioControlMessage(enable: enabled)
        sendEvenHubCommand(msg)
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // MARK: - SGCManager: Connection Management

    func findCompatibleDevices() {
        Bridge.log("G2: findCompatibleDevices()")
        DEVICE_SEARCH_ID = "NOT_SET"
        startScan()
    }

    func connectById(_ id: String) {
        Bridge.log("G2: connectById(\(id))")
        DEVICE_SEARCH_ID = id
        startScan()
        startPairingTimeout()
    }

    private func startPairingTimeout() {
        pairingTimeoutTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.leftPeripheral != nil && self.rightPeripheral == nil {
                Bridge.log("G2: pairing timeout — found LEFT but not RIGHT")
                Bridge.sendPairFailureEvent("errors:pairNeedDisconnect")
            }
        }
        pairingTimeoutTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    private func cancelPairingTimeout() {
        pairingTimeoutTimer?.cancel()
        pairingTimeoutTimer = nil
    }

    func disconnect() {
        Bridge.log("G2: disconnect()")
        isDisconnecting = true
        clearDisplay()
        cancelPairingTimeout()
        stopHeartbeats()
        Task { await reconnectionManager.stop() }

        // Disconnect known peripherals
        if let left = leftPeripheral {
            centralManager?.cancelPeripheralConnection(left)
        }
        if let right = rightPeripheral {
            centralManager?.cancelPeripheralConnection(right)
        }

        // Also disconnect any other G2 peripherals the system still has connected
        let connected = getConnectedDevices()
        for peripheral in connected {
            centralManager?.cancelPeripheralConnection(peripheral)
        }

        leftInitialized = false
        rightInitialized = false
        authStarted = false
        leftAuthenticated = false
        rightAuthenticated = false
        startupPageCreated = false
        pageCreated = false
        dashboardShowing = 0
        heartbeatCounter = 0
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
    }

    func forget() {
        stopHeartbeats()
        Task { await reconnectionManager.stop() }
        disconnect()
        // Note: leftGlassUUIDMap / rightGlassUUIDMap intentionally preserved so a future
        // pair to the same serial number can reuse the cached peripheral UUID.
        leftPeripheral = nil
        rightPeripheral = nil
        leftWriteChar = nil
        rightWriteChar = nil
        leftNotifyChar = nil
        rightNotifyChar = nil
        rightAudioChar = nil
        leftAudioChar = nil
        DEVICE_SEARCH_ID = "NOT_SET"
        centralManager?.delegate = nil
    }

    func cleanup() {
        disconnect()
    }

    func getConnectedBluetoothName() -> String? {
        return rightPeripheral?.name ?? leftPeripheral?.name
    }

    func ping() {
        sendEvenHubHeartbeat()
    }

    func connectController() {
        let isFullyBooted = DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
        guard isFullyBooted else {
            Bridge.log("G2: connectController - g2 not fully booted, ignoring")
            return
        }

        guard let mac = DeviceStore.shared.get("glasses", "controllerMacAddress") as? String else {
            Bridge.log("G2: connectController - no MAC address found")
            return
        }

        // Parse "AA:BB:CC:DD:EE:FF" into 6-byte Data
        let hexParts = mac.split(separator: ":").compactMap { UInt8($0, radix: 16) }
        guard hexParts.count == 6 else {
            Bridge.log("G2: connectController - invalid MAC format: \(mac)")
            return
        }
        let macData = Data(hexParts)

        let msg = DevSettingsProto.ringConnectInfo(
            magicRandom: sendManager.nextMagicRandom(),
            connect: true,
            ringMac: macData
        )
        sendDevSettingsCommand(msg)
        Bridge.log("G2: Sent RING_CONNECT_INFO for MAC \(mac)")
    }

    func disconnectController() {
        let isFullyBooted = DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
        guard isFullyBooted else {
            Bridge.log("G2: disconnectController - g2 not fully booted, ignoring")
            return
        }

        guard let mac = DeviceStore.shared.get("glasses", "controllerMacAddress") as? String else {
            Bridge.log("G2: disconnectController - no MAC address found")
            return
        }

        // Parse "AA:BB:CC:DD:EE:FF" into 6-byte Data
        let hexParts = mac.split(separator: ":").compactMap { UInt8($0, radix: 16) }
        guard hexParts.count == 6 else {
            Bridge.log("G2: disconnectController - invalid MAC format: \(mac)")
            return
        }
        let macData = Data(hexParts)

        let msg = DevSettingsProto.ringConnectInfo(
            magicRandom: sendManager.nextMagicRandom(),
            connect: false,
            ringMac: macData
        )
        sendDevSettingsCommand(msg)

        // DeviceStore.shared.apply("glasses", "controllerMacAddress", "")
        DeviceStore.shared.apply("glasses", "controllerConnected", false)
        DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
        Bridge.log("G2: Sent RING_DISCONNECT_INFO for MAC \(mac)")
    }

    /// Fire an EvenAI skill — the same path "Hey Even, show X" uses. Triggers a
    /// built-in glasses UI (notification list, navigation, teleprompter, etc).
    /// See `EvenAIProto.triggerSkill` for the skillId table.
    func triggerSkill(
        _ skillId: Int32, skillParam: Int32 = 0,
        text: String = "", streamEnable: Int32 = 1, fTextEnd: Int32 = 1
    ) {
        Bridge.log(
            "G2: triggerSkill(\(skillId), skillParam=\(skillParam), text=\"\(text)\", streamEnable=\(streamEnable), fTextEnd=\(fTextEnd))"
        )
        let payload = EvenAIProto.triggerSkill(
            magicRandom: sendManager.nextMagicRandom(),
            skillId: skillId,
            skillParam: skillParam,
            text: text,
            streamEnable: streamEnable,
            fTextEnd: fTextEnd
        )
        sendEvenAICommand(payload)
    }

    /// Open the on-glasses notification panel — same effect as the user saying
    /// "Hey Even, show notifications". Replicates the official-app voice flow:
    ///   1. CTRL{status=ENTER}     — puts glasses in AI session
    ///   2. ASK{text=" "}          — minimal ASR transcript to seed session context
    ///   3. SKILL{skillId=NOTIFICATION, skillParam=show, ...} — dispatches the intent
    /// The SKILL step alone is ignored by firmware; the preceding ENTER+ASK
    /// supply the session context that lets the glasses act on the SKILL.
    func showNotificationsPanel() async {
        Bridge.log("G2: showNotificationsPanel()")

        let enterPayload = EvenAIProto.aiCtrl(
            magicRandom: sendManager.nextMagicRandom(),
            status: 2  // EVEN_AI_ENTER
        )
        sendEvenAICommand(enterPayload)

        try? await Task.sleep(nanoseconds: 400_000_000)
        let askPayload = EvenAIProto.aiAsk(
            magicRandom: sendManager.nextMagicRandom(),
            text: " ",
            streamEnable: 0
        )
        sendEvenAICommand(askPayload)

        try? await Task.sleep(nanoseconds: 400_000_000)
        triggerSkill(
            3, skillParam: 1,  // NOTIFICATION, show
            text: " ",
            streamEnable: 1, fTextEnd: 1
        )
    }

    func dbg1() {
        setCalendarWidgetFirst()
        // toggleHeyEven()
    }

    private var compassRunning = false

    func dbg2() {
        // compassRunning.toggle()
        // Bridge.log("G2: dbg2() — \(compassRunning ? "start" : "stop") compass")
        // if compassRunning {
        //     startCompass()
        // } else {
        //     stopCompass()
        // }
    }

    /// Start a navigation session so the glasses stream compass heading via
    /// OS_NOTIFY_COMPASS_CHANGED — surfaced as `CompassHeadingEvent { heading: 0…359 }`
    /// in handleNavigationResponse.
    ///
    /// If the magnetometer needs calibration, the glasses emit
    /// OS_NOTIFY_COMPASS_CALIBRATE_STRAT (→ `CompassCalibrationEvent {status:"start"}`);
    /// the wearer should look around until `…{status:"complete"}`.
    func startCompass() {
        var w = ProtobufWriter()
        w.writeInt32Field(1, NavigationCmd.appRequestStartUp.rawValue)  // cmd
        w.writeInt32Field(2, sendManager.nextMagicRandom())  // magicRandom
        sendNavigationCommand(w.data)
    }

    /// Stop the navigation/compass session (ends heading streaming).
    func stopCompass() {
        var w = ProtobufWriter()
        w.writeInt32Field(1, NavigationCmd.appRequestExit.rawValue)
        w.writeInt32Field(2, sendManager.nextMagicRandom())
        sendNavigationCommand(w.data)
    }

    func setImuEnabled(_ enabled: Bool) async {
        await setImuEnabled(enabled, reportFrq: EvenHubProto.imuPaceP100)
    }

    /// Enable or disable IMU motion reporting on the glasses.
    ///
    /// When enabled, the glasses continuously push `IMU_Report_Data { x, y, z }` (32-bit
    /// floats, gravity-normalized) via the EvenHub notify path; these surface in
    /// `handleTouchEvent` as a Sys_ItemEvent with `eventType == IMU_DATA_REPORT (8)` and
    /// are emitted through `Bridge.sendAccelEvent` (a single accelerometer reading;
    /// a richer combined IMU event covering gyro + magnetometer is future work).
    ///
    /// - Parameters:
    ///   - enabled: `true` to start streaming, `false` to stop.
    ///   - reportFrq: ImuReportPace pacing code (100…1000, step 100 — protocol codes, not
    ///     Hz). Ignored when disabling.
    func setImuEnabled(_ enabled: Bool, reportFrq: Int32 = EvenHubProto.imuPaceP100) async {
        Bridge.log("G2: setImuEnabled(\(enabled), frq=\(reportFrq))")

        // IMU requires an active EvenHub page (same prerequisite as the mic).
        if enabled && !pageCreated {
            await rebuildState()
        }

        let send = { [weak self] in
            guard let self = self else { return }
            let msg = EvenHubProto.imuControlMessage(
                enable: enabled, reportFrq: reportFrq,
                magicRandom: self.sendManager.nextMagicRandom()
            )
            self.sendEvenHubCommand(msg)
        }

        // If we just asked for a page, give it a moment to be created first.
        if enabled, !pageCreated {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: send)
        } else {
            send()
        }
    }

    // MARK: - SGCManager: Device Control

    func setHeadUpAngle(_ angle: Int) {
        let clamped = min(max(angle, 0), 60)
        Bridge.log("G2: setHeadUpAngle(\(clamped))")

        // Enable head-up display
        let enableMsg = G2SettingProto.setHeadUpSwitch(
            magicRandom: sendManager.nextMagicRandom(),
            enabled: true
        )
        sendG2SettingCommand(enableMsg)

        // Set the angle
        let angleMsg = G2SettingProto.setHeadUpAngle(
            magicRandom: sendManager.nextMagicRandom(),
            angle: Int32(clamped)
        )
        sendG2SettingCommand(angleMsg)
    }

    func getBatteryStatus() {
        Bridge.log("G2: getBatteryStatus()")
        requestDeviceInfo()
    }

    /// Reorder the dashboard widgets so the calendar (Schedule) widget appears first.
    ///
    /// Sends a Dashboard_Receive (service 0x01) display-settings push with
    /// `widgetDisplayOrder` led by WidgetType 3 (Schedule). The remaining widgets
    /// keep their default relative order.
    ///   WidgetType: 1=News, 2=Stock, 3=Schedule, 4=Quicklist, 5=Health
    func setCalendarWidgetFirst() {
        // Schedule (calendar) first, then the rest in their default order.
        let widgetOrder: [UInt8] = [3, 1, 2, 4, 5]

        var dashDisplayW = ProtobufWriter()
        dashDisplayW.writeInt32Field(1, 4)  // displayMode
        dashDisplayW.writeInt32Field(2, 3)  // statusDisplayCount
        dashDisplayW.writeMessageField(3, Data([1, 2, 3]))  // statusDisplayOrder
        dashDisplayW.writeInt32Field(4, Int32(widgetOrder.count))  // widgetDisplayCount
        dashDisplayW.writeMessageField(5, Data(widgetOrder))  // widgetDisplayOrder: Schedule first
        dashDisplayW.writeInt32Field(6, dashboardHalfDayFormat())  // halfDayFormat
        dashDisplayW.writeInt32Field(7, dashboardTemperatureUnit())  // temperatureUnit

        var dashRecvW = ProtobufWriter()
        dashRecvW.writeMessageField(2, dashDisplayW.data)

        var dashPkgW = ProtobufWriter()
        dashPkgW.writeInt32Field(1, 2)  // Dashboard_Receive
        dashPkgW.writeInt32Field(2, sendManager.nextMagicRandom())
        dashPkgW.writeMessageField(4, dashRecvW.data)
        sendDashboardCommand(dashPkgW.data)

        Bridge.log("G2: setCalendarWidgetFirst — widgetDisplayOrder \(widgetOrder)")
    }

    func setDashboardMenu(_ items: [[String: Any]]) {
        let menuItems = items.compactMap { dict -> MenuProto.MenuItem? in
            guard let name = dict["name"] as? String,
                let packageName = dict["packageName"] as? String
            else { return nil }
            let running = dict["running"] as? Bool ?? false
            return MenuProto.MenuItem(packageName: packageName, name: name, running: running)
        }
        dashboardMenuItems = menuItems
        Bridge.log("G2: setDashboardMenu — sending \(menuItems.count) items")
        let (msg, appIdMap) = MenuProto.sendMenuInfo(
            magicRandom: sendManager.nextMagicRandom(),
            items: menuItems
        )
        menuAppIdToPackageName = appIdMap
        activeMenuAppId = appIdMap.keys.sorted().first
        sendMenuCommand(msg)
    }

    func setSilentMode(_: Bool) {
        // TODO: Implement
    }

    func exit() {
        Bridge.log("G2: exit()")
        clearDisplay()
    }

    func sendShutdown() {
        Bridge.log("G2: sendShutdown()")
        clearDisplay()
        disconnect()
    }

    func sendReboot() {
        // TODO: Implement via dev_settings
    }

    /// Push the current time to the glasses. Useful after DST transitions,
    /// time-zone travel, or a long sleep where the glasses' clock has drifted.
    func syncTime() {
        Bridge.log("G2: syncTime()")
        let msg = DevSettingsProto.timeSync(magicRandom: sendManager.nextMagicRandom())
        sendDevSettingsCommand(msg, left: true, right: true)
    }

    func sendRgbLedControl(
        requestId _: String, packageName _: String?, action _: String, color _: String?,
        onDurationMs _: Int, offDurationMs _: Int, count _: Int
    ) {
        // G2 doesn't have RGB LEDs
    }

    // MARK: - SGCManager: Messaging

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {
        // G2 doesn't use JSON messaging
    }

    // MARK: - SGCManager: Camera & Media (not supported on G2)

    func requestPhoto(_: PhotoRequest) {}
    func startVideoRecording(requestId _: String, save _: Bool, flash _: Bool, sound _: Bool) {}
    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func stopVideoRecording(requestId _: String) {}
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func sendButtonCameraLedSetting() {}

    func sendCameraFovSetting() {}

    // MARK: - SGCManager: Network (G2 has no WiFi)

    func requestWifiScan() {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendOtaStart(otaVersionUrl: String?) {}
    func sendOtaQueryStatus() {}

    // MARK: - SGCManager: User Context

    func sendUserEmailToGlasses(_: String) {
        // TODO: Could send via dev_settings
    }

    // MARK: - SGCManager: Gallery

    func queryGalleryStatus() {}
    func sendGalleryMode() {}

    // MARK: - SGCManager: Version Info

    func requestVersionInfo() {
        Bridge.log("G2: requestVersionInfo()")
        requestDeviceInfo()
    }

    // MARK: - BLE Scanning

    @discardableResult
    private func startScan() -> Bool {
        Bridge.log("G2: startScan()")
        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self, queue: G2._bluetoothQueue,
                options: [CBCentralManagerOptionShowPowerAlertKey: 0]
            )
        }

        isDisconnecting = false
        guard centralManager!.state == .poweredOn else {
            Bridge.log("G2: Bluetooth not powered on")
            return false
        }

        let devices = getConnectedDevices()
        Bridge.log("G2: connnectedDevices.count: (\(devices.count))")
        for device in devices {
            if let name = device.name, let serialNumber = deviceNameToSerialNumber[name] {
                Bridge.log("G2: Connected to device: \(name)")

                if name.contains("_L_") && serialNumber.contains(DEVICE_SEARCH_ID) {
                    leftPeripheral = device
                    device.delegate = self
                    device.discoverServices([G2BLE.SERVICE_UUID])
                    centralManager!.connect(
                        leftPeripheral!,
                        options: [
                            CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
                        ]
                    )
                } else if name.contains("_R_") && serialNumber.contains(DEVICE_SEARCH_ID) {
                    rightPeripheral = device
                    device.delegate = self
                    device.discoverServices([G2BLE.SERVICE_UUID])
                    centralManager!.connect(
                        rightPeripheral!,
                        options: [
                            CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
                        ]
                    )
                }
                // we can't emit the serial number here unfortunately:
                emitDiscoveredDevice(serialNumber)
            }
        }

        // Try UUID-based reconnection first
        if connectByUUID() {
            return true
        }

        centralManager!.scanForPeripherals(
            withServices: nil,
            options: [
                CBCentralManagerScanOptionAllowDuplicatesKey: false
            ]
        )
        return true
    }

    func stopScan() {
        centralManager?.stopScan()
    }

    private func connectByUUID() -> Bool {
        // don't do this if we don't have a search id set:
        if DEVICE_SEARCH_ID == "NOT_SET" || DEVICE_SEARCH_ID.isEmpty {
            Bridge.log("G2: 🔵 No DEVICE_SEARCH_ID set, skipping connect by UUID")
            return false
        }

        guard let leftUUID = leftGlassUUID(forSN: DEVICE_SEARCH_ID),
            let rightUUID = rightGlassUUID(forSN: DEVICE_SEARCH_ID)
        else { return false }

        let knownLeft = centralManager?.retrievePeripherals(withIdentifiers: [leftUUID])
        let knownRight = centralManager?.retrievePeripherals(withIdentifiers: [rightUUID])

        guard let left = knownLeft?.first, let right = knownRight?.first else { return false }

        // Validate the cached peripherals match the device the user selected
        let leftName = left.name ?? ""
        let rightName = right.name ?? ""
        // if !leftName.isEmpty && !leftName.contains(DEVICE_SEARCH_ID) {
        //     Bridge.log(
        //         "G2: connectByUUID - cached left '\(leftName)' doesn't match search ID '\(DEVICE_SEARCH_ID)', skipping"
        //     )
        //     return false
        // }
        // if !rightName.isEmpty && !rightName.contains(DEVICE_SEARCH_ID) {
        //     Bridge.log(
        //         "G2: connectByUUID - cached right '\(rightName)' doesn't match search ID '\(DEVICE_SEARCH_ID)', skipping"
        //     )
        //     return false
        // }

        Bridge.log("G2: connectByUUID - left: \(leftName), right: \(rightName)")

        leftPeripheral = left
        rightPeripheral = right
        left.delegate = self
        right.delegate = self
        centralManager?.connect(left, options: nil)
        centralManager?.connect(right, options: nil)
        return true
    }

    private func getConnectedDevices() -> [CBPeripheral] {
        // G2 exposes multiple BLE service families (EvenHub 0x2760, Nordic UART 6E40, BAE8).
        // Check all of them — if the Even app was the last to connect, iOS may have cached
        // a different service than our primary one, and retrieveConnectedPeripherals only
        // returns peripherals whose services match.
        let serviceUUIDs: [CBUUID] = [
            G2BLE.SERVICE_UUID,  // EvenHub: 00002760-...-0000
            CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"),  // Nordic UART
        ]
        var devices: [CBPeripheral] = []
        for svc in serviceUUIDs {
            let found = centralManager?.retrieveConnectedPeripherals(withServices: [svc]) ?? []
            for d in found {
                if !devices.contains(where: { $0.identifier == d.identifier }) {
                    devices.append(d)
                }
            }
        }
        return devices
    }

    private func emitDiscoveredDevice(_ serialNumber: String) {
        // Extract the numeric ID from name like "Even G2_32_R_3FFA6D" -> "32"
        // guard let idNumber = extractIdNumber(name) else {
        //     Bridge.log("G2: Could not extract ID from: \(name)")
        //     return
        // }
        Bridge.sendDiscoveredDevice(DeviceTypes.G2, serialNumber)
    }

    private func extractIdNumber(_ name: String) -> Int? {
        // Name format: "Even G2_XX_L_XXXXXX" or "Even G2_XX_R_XXXXXX"
        // Extract XX (the numeric ID between G2_ and _L_/_R_)
        let pattern = "G2_(\\d+)_"
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
            let range = Range(match.range(at: 1), in: name)
        else {
            return nil
        }
        return Int(name[range])
    }

    // MARK: - Incoming Data Handling

    private func handleNotifyData(_ data: Data, from peripheral: CBPeripheral) async {
        // Distinguish left vs right peripheral so multi-packet reassembly doesn't collide
        let sourceKey = peripheral === leftPeripheral ? "L" : "R"
        guard let result = receiveManager.handlePacket(data, sourceKey: sourceKey) else { return }
        // Bridge.log(
        //     "G2: handleNotifyData() - serviceId=\(result.serviceId), payload=\(result.payload.count) bytes"
        // )

        // Route based on service ID
        switch result.serviceId {
        case ServiceID.evenHub.rawValue:
            handleEvenHubResponse(result.payload)
        case ServiceID.deviceSettings.rawValue:
            handleDevSettingsResponse(result.payload, sourceKey: sourceKey)
        case ServiceID.g2Setting.rawValue:
            handleG2SettingResponse(result.payload)
        case ServiceID.menu.rawValue:
            handleMenuResponse(result.payload)
        case ServiceID.dashboard.rawValue:
            handleDashboardResponse(result.payload)
        case ServiceID.gestureCtrl.rawValue:
            await handleGestureCtrl(result.payload)
        case ServiceID.navigation.rawValue:
            handleNavigationResponse(result.payload)
        case ServiceID.evenAI.rawValue:
            handleEvenAIResponse(result.payload)
        case ServiceID.evenHubCtrl.rawValue:
            handleEvenHubCtrlResponse(result.payload)
        default:
            Bridge.log(
                "G2: Unhandled service \(result.serviceId) (\(result.payload.count) bytes): \(result.payload.map { String(format: "%02X", $0) }.joined())"
            )
        }
    }

    /// EvenAI service (0x07). Logs the decoded EvenAIDataPackage so we can read the
    /// CONFIG (Hey Even) echo: commandId=10 (CONFIG), config sub-message in field 13.
    private func handleEvenAIResponse(_ payload: Data) {
        var reader = ProtobufReader(payload)
        let fields = reader.parseFields()
        let cmd = fields[1] as? Int32 ?? -1
        if cmd == 10, let configData = fields[13] as? Data {
            var cReader = ProtobufReader(configData)
            let cFields = cReader.parseFields()
            let voiceSwitch = cFields[1] as? Int32 ?? 0  // omitted = 0 = OFF
            Bridge.log(
                "G2: EvenAI CONFIG echo — voiceSwitch=\(voiceSwitch) (\(voiceSwitch == 1 ? "ON" : "OFF")) config=\(cFields)"
            )
        } else {
            Bridge.log(
                "G2: EvenAI cmd=\(cmd) fields=\(Array(fields.keys).sorted()) raw=\(payload.map { String(format: "%02X", $0) }.joined())"
            )
        }
    }

    /// Navigation service (0x08).
    ///
    /// OS_NOTIFY_COMPASS_CHANGED (15) carries the magnetometer heading in
    /// compass_info_msg (field 10) → field 1, as whole degrees 0…359. (The proto names
    /// that field `compassIndex`, but on the notify path it's the live heading — verified
    /// on-device: values sweep 0–359 as the wearer turns.)
    private func handleNavigationResponse(_ payload: Data) {
        var reader = ProtobufReader(payload)
        let fields = reader.parseFields()
        guard let cmd = fields[1] as? Int32 else { return }

        switch cmd {
        case NavigationCmd.osNotifyCompassChanged.rawValue:
            guard let compassData = fields[10] as? Data else { return }
            var cReader = ProtobufReader(compassData)
            let cFields = cReader.parseFields()
            guard let heading = cFields[1] as? Int32 else { return }
            // Heading in degrees, 0…359.
            Bridge.log("G2: compass heading=\(heading)°")
            Bridge.sendTypedMessage(
                "CompassHeadingEvent",
                body: [
                    "heading": Int(heading),
                    "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
                ])

        case NavigationCmd.osNotifyCompassCalibrateStart.rawValue:
            Bridge.log("G2: compass calibration started — wearer should look around")
            Bridge.sendTypedMessage("CompassCalibrationEvent", body: ["status": "start"])

        case NavigationCmd.osNotifyCompassCalibrateComplete.rawValue:
            Bridge.log("G2: compass calibration complete")
            Bridge.sendTypedMessage("CompassCalibrationEvent", body: ["status": "complete"])

        default:
            break
        }
    }

    private func handleEvenHubResponse(_ payload: Data) {
        // Parse evenhub_main_msg_ctx: field 1 = Cmd (varint), field 13 = DevEvent (submessage)
        var reader = ProtobufReader(payload)
        let fields = reader.parseFields()

        guard let cmdValue = fields[1] as? Int32 else {
            Bridge.log(
                "G2: EvenHub response - no cmd field, \(payload.count) bytes: \(payload.map { String(format: "%02X", $0) }.joined())"
            )
            return
        }

        // Bridge.log("G2: EvenHub incoming cmd=\(cmdValue), fields=\(Array(fields.keys).sorted())")

        if cmdValue == EvenHubResponseCmd.osNotifyEventToApp.rawValue {
            // Touch/gesture event from glasses
            guard let devEventData = fields[13] as? Data else { return }
            let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
            if lastClickTimestamp != nil && timestamp - lastClickTimestamp! < 100 {
                // Bridge.log("G2: Double click ignored (too soon)")
                return
            }
            lastClickTimestamp = timestamp
            handleTouchEvent(devEventData)
        } else if cmdValue == 17 {
            // Miniapp selection from glasses dashboard menu (cmdId=17)
            // Dedup: L and R peripherals both deliver this event, so debounce or
            // MantleManager toggles start→stop in quick succession.
            let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
            if lastMenuSelectTimestamp != nil && timestamp - lastMenuSelectTimestamp! < 500 {
                return
            }
            lastMenuSelectTimestamp = timestamp
            // field 20 contains sub-message with field 1 = itemAppId
            if let selectData = fields[20] as? Data {
                var selectReader = ProtobufReader(selectData)
                let selectFields = selectReader.parseFields()
                if let appId = selectFields[1] as? Int32 {
                    // Resolve appId → packageName using our stored mapping
                    if let packageName = menuAppIdToPackageName[appId] {
                        Bridge.log("G2: Menu miniapp selected — \(packageName)")
                        Bridge.sendMiniappSelected(packageName: packageName)
                        // clear the display after a delay:
                        // DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        //     self.clearDisplay()
                        // }
                    } else {
                        Bridge.log(
                            "G2: Menu selection ignored — placeholder or unknown appId=\(appId)"
                        )
                    }
                }
            }
        } else {

            // response codes:
            let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
            if lastEvenHubResponseTimestamp != nil
                && timestamp - lastEvenHubResponseTimestamp! < 100
            {
                return
            }
            lastEvenHubResponseTimestamp = timestamp

            // Log unhandled EvenHub commands (helps debug menu selection and stock dashboard interactions)
            // Bridge.log(
            //     "G2: EvenHub response cmd=\(cmdValue), \(payload.count) bytes, fields=\(Array(fields.keys).sorted())"
            // )

            // Parse error codes from responses
            // field 4 = StartupResCmd, field 6 = ImgResCmd, field 8 = RebuildResCmd, field 10 = TextResCmd
            for resField in [4, 6, 8, 10] {
                if let resData = fields[resField] as? Data {
                    var resReader = ProtobufReader(resData)
                    let resFields = resReader.parseFields()
                    if let errorCode = resFields[1] as? Int32 {
                        // 0=page_success, 4=img_success, 5=img_failed, 6=rebuild_success, 7=rebuild_failed, 8=text_success, 9=text_failed
                        // Bridge.log("G2: EvenHub response field\(resField) errorCode=\(errorCode)")
                        if errorCode == 9 {
                            Bridge.log(
                                "G2: WARN: Glasses shutdown our EvenHub page — resetting page state"
                            )
                            pageCreated = false
                        }
                    }
                    if let errorCode = resFields[8] as? Int32 {
                        // ImgResCmd has ErrorCode in field 8
                        if errorCode == 4 {
                            Bridge.log("G2: img_success")
                        } else {
                            Bridge.log("G2: EvenHub ImgRes errorCode=\(errorCode)")
                        }
                    }
                }
            }

            // If glasses sent a shutdown (cmd=9/10), our page is gone — reset state
            if cmdValue == 9 || cmdValue == 10 {
                Bridge.log("G2: ERROR: Glasses shutdown our EvenHub page — resetting page state")
                pageCreated = false
            }
        }
    }

    private func setFullyConnected() {
        let isFullyConnected = DeviceStore.shared.get("glasses", "connected") as? Bool ?? false
        let isFullyBooted = DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
        if !isFullyConnected {
            DeviceStore.shared.apply("glasses", "connected", true)
        }
        if !isFullyBooted {
            DeviceStore.shared.apply("glasses", "fullyBooted", true)
        }
    }

    private func setControllerFullyConnected() {
        let isControllerConnected =
            DeviceStore.shared.get("glasses", "controllerConnected") as? Bool ?? false
        let isControllerFullyBooted =
            DeviceStore.shared.get("glasses", "controllerFullyBooted") as? Bool ?? false
        if !isControllerConnected {
            DeviceStore.shared.apply("glasses", "controllerConnected", true)
        }
        if !isControllerFullyBooted {
            DeviceStore.shared.apply("glasses", "controllerFullyBooted", true)
        }
    }

    /// Parse an IMU_Report_Data sub-message: fields 1/2/3 = x/y/z as 32-bit floats
    /// (wire type 5). `ProtobufReader.parseFields()` skips wire-type-5 fields, so this
    /// walks the bytes manually.
    private func parseImuReportData(_ data: Data) -> (x: Float, y: Float, z: Float)? {
        var x: Float?
        var y: Float?
        var z: Float?
        var i = data.startIndex
        while i < data.endIndex {
            let tag = data[i]
            i = data.index(after: i)
            let fieldNum = Int(tag >> 3)
            let wireType = Int(tag & 0x07)
            guard wireType == 5, data.distance(from: i, to: data.endIndex) >= 4 else { break }
            var bits: UInt32 = 0
            for b in 0..<4 {
                bits |= UInt32(data[data.index(i, offsetBy: b)]) << (8 * b)  // little-endian
            }
            i = data.index(i, offsetBy: 4)
            let value = Float(bitPattern: bits)
            switch fieldNum {
            case 1: x = value
            case 2: y = value
            case 3: z = value
            default: break
            }
        }
        guard let x = x, let y = y, let z = z else { return nil }
        return (x, y, z)
    }

    private func handleTouchEvent(_ devEventData: Data) {
        // Parse SendDeviceEvent: field 1=ListEvent, field 2=TextEvent, field 3=SysEvent
        var reader = ProtobufReader(devEventData)
        let fields = reader.parseFields()

        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)

        // if we are receiving touch events we are fully booted:
        setFullyConnected()

        // Bridge.log("G2: handleTouchEvent: \(fields)")
        // Bridge.log(
        //     "G2: handleTouchEvent: \(devEventData.map { String(format: "%02X", $0) }.joined())")

        // SysEvent (field 3) - system-level gestures
        if let sysData = fields[3] as? Data {
            var sysReader = ProtobufReader(sysData)
            let sysFields = sysReader.parseFields()

            // IMU data report: eventType == IMU_DATA_REPORT (8), imuData in field 3
            // (IMU_Report_Data { x, y, z } as 32-bit floats). Handle and return before
            // the gesture-mapping path.
            if (sysFields[1] as? Int32) == OsEventType.imuDataReport.rawValue,
                let imuData = sysFields[3] as? Data,
                let imu = parseImuReportData(imuData)
            {
                Bridge.log("G2: IMU data report: \(imu.x), \(imu.y), \(imu.z)")
                Bridge.sendAccelEvent(x: imu.x, y: imu.y, z: imu.z, timestamp: timestamp)
                return
            }

            var eventType: OsEventType? = nil
            var eventSource: Int32? = nil
            if let normalType = sysFields[1] as? Int32 {
                eventType = OsEventType(rawValue: normalType)
            } else {
                eventType = OsEventType.click
            }
            if let source = sysFields[2] as? Int32 {
                eventSource = source
            }

            // Bridge.log("G2: sysFields: \(sysFields)")

            guard let eventType = eventType else {
                Bridge.log("G2: unknown event type: \(sysFields)")
                return
            }

            guard let gestureName = mapEventTypeToGesture(eventType) else {
                Bridge.log("G2: no gesture mapping for \(eventType) \(sysFields)")
                return
            }

            Bridge.sendTouchEvent(
                deviceModel: DeviceTypes.G2, gestureName: gestureName,
                timestamp: timestamp,
                source: eventSource
            )
            Bridge.log("G2: SysEvent → \(eventType) \(eventSource)")

            if eventSource == 2 {
                // controller must be connected and fully booted:
                setControllerFullyConnected()
            }

            if eventType == .doubleClick {
                // trigger dashboard:
                let isHeadUp = DeviceStore.shared.get("glasses", "headUp") as? Bool ?? false

                let useNativeDashboard =
                    DeviceStore.shared.get("bluetooth", "use_native_dashboard") as? Bool ?? false
                if useNativeDashboard {
                    showDashboard()
                } else {
                    // toggle head up:
                    DeviceStore.shared.apply("glasses", "headUp", !isHeadUp)
                }

                // if isHeadUp {
                //     // Bridge.log("G2: going back to home, clearing display")
                //     // clear the display after a delay:
                //     DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                //         self.clearDisplay()
                //     }
                // }
                // sendDashboardCommand(DashboardCommand.trigger)

                // toggle head up:
                // DeviceStore.shared.apply("glasses", "headUp", true)
            }

            // if eventType == .foregroundEnter {
            //     Bridge.log("G2: Foreground enter detected")
            // }

            // if eventType == .click {
            //     Bridge.log("G2: Click detected")
            // }

            // System exit: glasses killed our EvenHub page (user opened menu or another app)
            // Reset page state and re-create the page to reclaim EvenHub focus
            if eventType == .systemExit || eventType == .abnormalExit {
                // Bridge.log("G2: System exit detected")
                pageCreated = false
                // Firmware kills the mic on system exit; re-arm it if it should be on
                DeviceStore.shared.apply("glasses", "micEnabled", false)
                DeviceManager.shared.updateMicState()
                // Force re-create the page to reclaim EvenHub focus
                // Task {
                //     try? await Task.sleep(nanoseconds: 1_000_000_000)  // 1000ms for glasses to finish transition
                //     if !savedBitmap.isEmpty {
                //         await self.displayBitmap(base64ImageData: savedBitmap)
                //     } else {
                //         self.sendTextWall(savedText.isEmpty ? " " : savedText)
                //     }
                // }
            }
            return
        }

        // TextEvent (field 2) - tap on text container
        if let textData = fields[2] as? Data {
            var textReader = ProtobufReader(textData)
            let textFields = textReader.parseFields()
            if let eventTypeRaw = textFields[3] as? Int32,
                let eventType = OsEventType(rawValue: eventTypeRaw)
            {
                guard let gestureName = mapEventTypeToGesture(eventType) else {
                    Bridge.log("G2: no gesture mapping for \(eventType) \(textFields)")
                    return
                }
                Bridge.sendTouchEvent(
                    deviceModel: DeviceTypes.G2, gestureName: gestureName, timestamp: timestamp
                )
                Bridge.log("G2: TextEvent → \(gestureName)")
            }
            return
        }

        // ListEvent (field 1) - interaction with list container
        // if let listData = fields[1] as? Data {
        //     var listReader = ProtobufReader(listData)
        //     let listFields = listReader.parseFields()
        //     if let eventTypeRaw = listFields[5] as? Int32,
        //         let eventType = OsEventType(rawValue: eventTypeRaw)
        //     {
        //         let gestureName = mapEventTypeToGesture(eventType)
        //         if let gestureName = gestureName {
        //             Bridge.sendTouchEvent(
        //                 deviceModel: DeviceTypes.G2, gestureName: gestureName, timestamp: timestamp
        //             )
        //             Bridge.log("G2: ListEvent → \(gestureName)")
        //         }
        //     }
        // }
    }

    private func mapEventTypeToGesture(_ eventType: OsEventType) -> String? {
        switch eventType {
        case .click: return "single_tap"
        case .doubleClick: return "double_tap"
        case .scrollTop: return "swipe_up"
        case .scrollBottom: return "swipe_down"
        case .foregroundEnter: return "foreground_enter"
        case .foregroundExit: return "foreground_exit"
        case .systemExit: return "system_exit"
        case .imuDataReport: return nil
        case .abnormalExit: return nil  // don't report abnormal exits as gestures
        }
    }

    private func reconnectController() {
        let mac = DeviceStore.shared.get("glasses", "controllerMacAddress") as? String ?? ""
        guard !mac.isEmpty else {
            Bridge.log("G2: reconnectController - no MAC address found")
            return
        }
        connectController()
    }

    private func handleDevSettingsResponse(_ data: Data, sourceKey: String) {
        // DevSettings responses (auth acks, heartbeat acks) — mostly informational

        var reader = ProtobufReader(data)
        let fields = reader.parseFields()

        let cmdValue = fields[1] as? Int32 ?? -1

        // if the data is just a heartbeat, ignore it:
        if let cmdValue = fields[1] as? Int32,
            cmdValue == DevCfgCommandId.baseConnHeartBeat.rawValue
        {
            return
        }
        // Bridge.log("G2: DevSettings response cmdValue=\(cmdValue)")

        // Bridge.log(
        //     "G2: DevSettings response: \(data.prefix(32).map { String(format: "%02X", $0) }.joined(separator: ":"))"
        // )

        // RING_CONNECT_INFO response (cmd 6)
        if cmdValue == DevCfgCommandId.ringConnectInfo.rawValue {
            // let connStat = fields[4] as? Int32 ?? -1
            // // if it's 3c or 3d that's disconnected:
            // if connStat == 0x3c || connStat == 0x3d {
            //     Bridge.log("G2: Ring disconnected")
            //     DeviceStore.shared.apply("glasses", "controllerConnected", false)
            //     DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
            //     DeviceStore.shared.apply("glasses", "controllerSearching", true)
            // }

            // Bridge.log("G2: Ring connection status: connStat=\(connStat)")

            // Bridge.log("G2: RingConnectInfo: \(fields)")
            if let ringData = fields[5] as? Data {  // field 5 = ringInfo
                var ringReader = ProtobufReader(ringData)
                let ringFields = ringReader.parseFields()

                // Bridge.log("G2: RingInfo: \(ringFields)")

                if ringFields[1] as? Int32 ?? 0 == 1 {
                    Bridge.log("G2: Ring maybe connected?")
                    // DeviceStore.shared.apply("glasses", "controllerConnected", true)
                    DeviceStore.shared.apply("glasses", "controllerFullyBooted", true)
                }

                if ringFields[4] as? Int32 ?? 0 == 62 {
                    Bridge.log("G2: Ring maybe reconnected?")
                    // DeviceStore.shared.apply("glasses", "controllerConnected", true)
                    DeviceStore.shared.apply("glasses", "controllerFullyBooted", true)
                }
            }

            // if the data ends in 2016 that's a disconnect?:
            // if data.suffix(4) == Data([0x20, 0x16]) {
            //     Bridge.log("G2: Ring disconnected")
            //     DeviceStore.shared.apply("glasses", "controllerConnected", false)
            //     DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
            //     DeviceStore.shared.apply("glasses", "controllerSearching", true)
            // }

            if let ringData = fields[5] as? Data {  // field 5 = ringInfo
                var ringReader = ProtobufReader(ringData)
                let ringFields = ringReader.parseFields()
                let connStatus = ringFields[4] as? Int32 ?? -1  // field 4 = connStatus
                // Bridge.log(
                //     "G2: Ring connection status: connStatus?=\(connStatus))"
                // )

                if connStatus == 22 {
                    Bridge.log("G2: Ring disconnected")
                    DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
                    DeviceStore.shared.apply("glasses", "controllerSearching", true)
                    reconnectController()
                }

                if connStatus == 8 {
                    Bridge.log("G2: Ring maybe disconnected?")
                    // DeviceStore.shared.apply("glasses", "controllerConnected", false)
                    // DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
                    // DeviceStore.shared.apply("glasses", "controllerSearching", true)
                    // reconnectController()
                }
                // // DeviceStore.shared.apply("glasses", "ringConnectedToGlasses", connected)
            }
        }

        if cmdValue == DevCfgCommandId.authentication.rawValue {
            // DevCfgDataPackage: field 2 = magicRandom, field 3 = AuthMgr { field 1 = secAuth }
            let magicRandom = fields[2] as? Int32 ?? -1
            var secAuth: Bool? = nil
            if let authData = fields[3] as? Data {
                var authReader = ProtobufReader(authData)
                let authFields = authReader.parseFields()
                if let v = authFields[1] as? Int32 {
                    secAuth = (v != 0)
                }
            }
            let secAuthStr = secAuth.map { $0 ? "true" : "false" } ?? "?"
            Bridge.log("G2: Authentication response: \(sourceKey) secAuth=\(secAuthStr)")
            if secAuth == true {
                if sourceKey == "L" {
                    leftAuthenticated = true
                } else if sourceKey == "R" {
                    rightAuthenticated = true
                }
                if leftAuthenticated && rightAuthenticated {
                    Bridge.log("G2: Both sides authenticated, setting fully booted and connected")
                    setFullyConnected()
                }
            }
        }
    }

    private func handleG2SettingResponse(_ payload: Data) {
        // Parse G2SettingPackage: field 1=commandId, field 4=DeviceReceiveRequestFromAPP (response), field 5=DeviceSendInfoToAPP
        var reader = ProtobufReader(payload)
        let fields = reader.parseFields()

        // Bridge.log("G2: G2Setting response: \(fields)")

        guard let cmdValue = fields[1] as? Int32 else { return }

        // DeviceReceiveRequest response (glasses sends back requested info)
        if cmdValue == G2SettingCommandId.deviceReceiveRequest.rawValue
            || cmdValue == G2SettingCommandId.deviceSendToApp.rawValue
        {
            // The response data might be in field 4 (deviceReceiveRequestFromApp) or field 5 (deviceSendInfoToApp)
            if let requestData = fields[4] as? Data {
                parseDeviceRequestResponse(requestData)
            }
            if let sendData = fields[5] as? Data {
                parseDeviceSendToApp(sendData)
            }
        }
    }

    private func parseDeviceRequestResponse(_ data: Data) {
        // DeviceReceiveRequestFromAPP fields:
        //   5 = leftSoftwareVersion (string), 6 = rightSoftwareVersion (string)
        //   12 = battery (int32), 13 = chargingStatus (int32)
        var reader = ProtobufReader(data)
        let fields = reader.parseFields()

        // Bridge.log("G2: DeviceRequestResponse: \(fields)")

        // Battery
        if let battery = fields[12] as? Int32 {
            let level = Int(battery)
            if level >= 0 && level <= 100 {
                // Bridge.log("G2: Battery level: \(level)%")
                DeviceStore.shared.apply("glasses", "batteryLevel", level)
            }
        }

        // Charging status
        if let charging = fields[13] as? Int32 {
            let isCharging = charging != 0
            DeviceStore.shared.apply("glasses", "charging", isCharging)
            // Bridge.log("G2: Charging: \(isCharging)")
            // Re-send battery status with updated charging info
            if batteryLevel >= 0 {
                Bridge.sendBatteryStatus(level: batteryLevel, charging: isCharging)
            }
        }

        // Software versions
        if let leftVer = fields[5] as? Data,
            let leftVersion = String(data: leftVer, encoding: .utf8)
        {
            // Bridge.log("G2: Left firmware: \(leftVersion)")
            DeviceStore.shared.apply("glasses", "leftFirmwareVersion", leftVersion)
        }
        if let rightVer = fields[6] as? Data,
            let rightVersion = String(data: rightVer, encoding: .utf8)
        {
            // Bridge.log("G2: Right firmware: \(rightVersion)")
            DeviceStore.shared.apply("glasses", "rightFirmwareVersion", rightVersion)
            // Use right version as the main version
            DeviceStore.shared.apply("glasses", "firmwareVersion", rightVersion)
        }
    }

    private func handleMenuResponse(_ data: Data) {
        // meun_main_msg_ctx response from glasses (ack of our menu send)
        // (informational only)
        Bridge.log(
            "G2: menu response: \(data.prefix(32).map { String(format: "%02X", $0) }.joined())"
        )
    }

    private func handleDashboardResponse(_ payload: Data) {
        Bridge.log(
            "G2: dashboard response: \(payload.map { String(format: "%02X", $0) }.joined())"
        )
        var reader = ProtobufReader(payload)
        let fields = reader.parseFields()
        let cmd = fields[1] as? Int32 ?? -1
        let magicRandom = fields[2] as? Int32 ?? 0

        // Parse field 6 (DashboardSendToApp) if present
        var packageId: Int32 = 0
        if let f6 = fields[6] as? Data {
            var subReader = ProtobufReader(f6)
            let sub = subReader.parseFields()
            packageId = sub[1] as? Int32 ?? 0
        }

        // cmd=3 is APP_Respond — glasses sending us info, we should respond with cmd=4 (APP_RECEIVE)
        // AppRespondToDashboard: field1=packageId, field2=flag (0=success)
        if cmd == 3 {
            var appRespW = ProtobufWriter()
            appRespW.writeInt32Field(1, packageId)  // packageId
            appRespW.writeInt32Field(2, 0)  // flag = APP_RECEIVED_SUCCESS

            var pkgW = ProtobufWriter()
            pkgW.writeInt32Field(1, 4)  // commandId = APP_RECEIVE
            pkgW.writeInt32Field(2, magicRandom)
            pkgW.writeMessageField(5, appRespW.data)  // field5 = appRespond
            sendDashboardCommand(pkgW.data)
        }
    }

    private func handleEvenHubCtrlResponse(_ data: Data) {
        // EvenHub CTRL channel response (informational only)
        Bridge.log(
            "G2: evenHubCtrl response: \(data.prefix(8).map { String(format: "%02X", $0) }.joined())"
        )
    }

    private func handleGestureCtrl(_ data: Data) async {
        // gesture_ctrl (service 0x0D): foreground lifecycle signals from glasses
        // (informational only — log if needed for debugging)
        // log first few bytes of the response:
        // Bridge.log(
        //     "G2: gesture_ctrl response: \(data.map { String(format: "%02X", $0) }.joined())"
        // )
        // Bridge.log("G2: gesture_ctrl response:")

        // Dedup: L and R peripherals both deliver this event, so debounce or
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        if lastGestureCtrlTimestamp != nil && timestamp - lastGestureCtrlTimestamp! < 500 {
            // Bridge.log("G2: gesture_ctrl dedup")
            return
        }
        lastGestureCtrlTimestamp = timestamp

        // if we got 08011A00 that means we closed the dashboard, which means the mic is probably dead,
        // so we need to revive it:
        if data == Data([0x08, 0x01, 0x1A, 0x00]) {
            Bridge.log("G2: dashboard closed / shutdown - dashboardShowing=\(dashboardShowing)")
            let useNativeDashboard =
                DeviceStore.shared.get("bluetooth", "use_native_dashboard") as? Bool ?? false
            if !useNativeDashboard {
                dashboardShowing = 0
                // rebuild state:
                Task {
                    await rebuildState()
                    // set the mic back on if it should be on
                    let micEnabled =
                        DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
                    if micEnabled {
                        restartMic()
                    }
                }
                return
            } else {
                // if we aren't trying to show the dashboard
                // then we need to turn the mic back on and display the mentra main page:
                if dashboardShowing <= 1 {
                    dashboardShowing = 0
                    // rebuild state:
                    await rebuildState()
                    // set the mic back on if it should be on
                    let micEnabled =
                        DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
                    if micEnabled {
                        restartMic()
                    }
                    return
                }
                // do nothing this time since we just closed the dashboard
                dashboardShowing -= 1
                if dashboardShowing < 0 {
                    dashboardShowing = 0
                }
            }
        }

        // if we got 08011097012200 that means we selected a menu item:
        // if data == Data([0x08, 0x01, 0x10, 0x97, 0x01, 0x22, 0x00]) {
        //     Bridge.log("G2: menu item selected, clearing display")
        //     clearDisplay()
        // }
    }

    private func parseDeviceSendToApp(_ data: Data) {
        // DeviceSendInfoToAPP: field 1 = currentRecalibrationStatus, field 2 = silentModeSwitch
        // Informational — just log for now
        var reader = ProtobufReader(data)
        let fields = reader.parseFields()
        if let silentMode = fields[2] as? Int32 {
            Bridge.log("G2: Silent mode: \(silentMode != 0)")
        }
    }

    private var lastAudioFrame: Data?

    private func handleAudioData(_ data: Data) async {
        // G2 audio arrives on AUDIO_NOTIFY characteristic
        // Format: ~200+ byte chunks, use first 200 bytes, split into 40-byte LC3 frames
        // Each frame: LC3, 16kHz, mono, 10ms, 40 bytes

        let usableLength = min(data.count, 200)
        guard usableLength >= 40 else { return }

        let audioData = Data(data.prefix(usableLength))
        if lastAudioFrame == audioData {
            // Bridge.log("G2: audio dup")
            return
        }
        lastAudioFrame = audioData

        // Forward LC3 data to DeviceManager for decoding
        // G2 uses 40-byte frames (vs G1's 20-byte frames)
        DeviceManager.shared.handleGlassesMicData(audioData, 40)
    }
}

// MARK: - CBCentralManagerDelegate

func extractSN(from data: Data) -> String? {
    // Android uses startSubIndex=7, byteLength=21 on the FULL scan record
    // iOS manufacturerData is just the manufacturer-specific payload,
    // so the offset may differ. You'll need to log the raw bytes and find
    // where the SN string starts.

    // Skip "ER" prefix (2 bytes), read 14 bytes of SN
    let snData = data[2..<16]
    return String(data: snData, encoding: .ascii)?
        .replacingOccurrences(
            of: "[\\x00-\\x1F\\x7F]", with: "", options: .regularExpression
        )
}

/// Extract the BLE MAC from G2 manufacturer data.
/// Layout: "ER"(2) + SN(14) + MAC(6, little-endian) + flag(1)
/// Returns "AA:BB:CC:DD:EE:FF" (big-endian, colon-separated).
func extractMac(from data: Data) -> String? {
    guard data.count >= 22 else { return nil }
    let macLE = data[16..<22]
    return macLE.reversed().map { String(format: "%02X", $0) }.joined(separator: ":")
}

extension G2: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("G2: Bluetooth state: \(state.rawValue)")
            if state == .poweredOn {
                _ = self.startScan()
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi _: NSNumber
    ) {
        guard
            let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey]
                as? String
        else { return }

        // G2 glasses have "Even" prefix and "G2" in name, with _L_ or _R_ for side
        guard name.contains("G2") else { return }
        guard let mfgData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
            mfgData.count >= 16
        else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            guard let serialNumber = extractSN(from: mfgData) else {
                Bridge.log("G2: Could not extract SN from manufacturer data")
                return
            }
            // sn = "S200LACA040040"
            let mfgHex = mfgData.map { String(format: "%02X", $0) }.joined(separator: " ")
            Bridge.log(
                "G2: Discovered: \(name) (SN: \(serialNumber)) mfgData[\(mfgData.count)]: \(mfgHex)"
            )
            self.deviceNameToSerialNumber[name] = serialNumber

            // Save MAC per side; ring's advStart needs the left lens MAC.
            if let mac = extractMac(from: mfgData) {
                if name.contains("_L_") {
                    DeviceStore.shared.apply("glasses", "leftMacAddress", mac)
                    DeviceStore.shared.apply("glasses", "bluetoothMacAddress", mac)
                } else if name.contains("_R_") {
                    DeviceStore.shared.apply("glasses", "rightMacAddress", mac)
                }
            }
            // DeviceStore.shared.apply("glasses", "signalStrength", RSSI.intValue)

            // Always emit discovered device to frontend
            self.emitDiscoveredDevice(serialNumber)

            // If scan-only mode (no search ID set), don't auto-connect
            guard self.DEVICE_SEARCH_ID != "NOT_SET" else { return }

            // Bridge.log("G2: SN: \(serialNumber), DEVICE_SEARCH_ID: \(self.DEVICE_SEARCH_ID) name: \(name)")

            // Only connect to devices matching our search ID
            guard serialNumber.contains(self.DEVICE_SEARCH_ID) else { return }

            if name.contains("_L_") {
                if self.leftPeripheral == nil {
                    self.leftPeripheral = peripheral
                    peripheral.delegate = self
                    central.connect(peripheral, options: nil)
                    // Bridge.log("G2: Connecting to LEFT: \(name)")
                }
            } else if name.contains("_R_") {
                if self.rightPeripheral == nil {
                    self.rightPeripheral = peripheral
                    peripheral.delegate = self
                    central.connect(peripheral, options: nil)
                    // Bridge.log("G2: Connecting to RIGHT: \(name)")
                }
            }

            // Stop scanning once we have both
            if self.leftPeripheral != nil && self.rightPeripheral != nil {
                self.stopScan()
                self.cancelPairingTimeout()
            }
        }
    }

    nonisolated func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("G2: Connected to \(peripheral.name ?? "unknown")")

            // Store UUID for reconnection, keyed by serial number.
            let sn = peripheral.name.flatMap { self.deviceNameToSerialNumber[$0] }
            if let sn = sn {
                if peripheral === self.leftPeripheral {
                    self.setLeftGlassUUID(peripheral.identifier, forSN: sn)
                } else if peripheral === self.rightPeripheral {
                    self.setRightGlassUUID(peripheral.identifier, forSN: sn)
                }
            } else {
                Bridge.log(
                    "G2: didConnect — no SN for \(peripheral.name ?? "unknown"), skipping UUID save"
                )
            }

            // Discover services - scan for all since we need to find the EvenHub characteristics
            peripheral.discoverServices(nil)
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let side = peripheral === self.leftPeripheral ? "LEFT" : "RIGHT"
            Bridge.log("G2: Disconnected \(side): \(error?.localizedDescription ?? "clean")")

            // Only reconnect if not intentionally disconnecting
            if self.isDisconnecting { return }

            // Clear both sides to force re-discovery (like G1)
            self.leftPeripheral = nil
            self.rightPeripheral = nil
            self.leftInitialized = false
            self.rightInitialized = false
            self.leftWriteChar = nil
            self.rightWriteChar = nil
            self.leftNotifyChar = nil
            self.rightNotifyChar = nil
            self.leftAudioChar = nil
            self.rightAudioChar = nil
            self.authStarted = false

            self.startupPageCreated = false
            self.pageCreated = false
            self.dashboardShowing = 0
            DeviceStore.shared.apply("glasses", "connected", false)
            DeviceStore.shared.apply("glasses", "fullyBooted", false)

            // Start persistent reconnection loop (every 30s, unlimited attempts)
            self.startReconnectionTimer()
        }
    }

    private func startReconnectionTimer() {
        Task {
            await reconnectionManager.start { [weak self] in
                guard let self else { return false }

                // Check if already connected
                if await MainActor.run(body: {
                    DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
                }) {
                    Bridge.log("G2: Already connected, stopping reconnection")
                    return true
                }

                Bridge.log("G2: Attempting reconnection...")

                await MainActor.run {
                    self.startScan()
                }

                // Return false to keep trying
                return false
            }
        }
    }
}

// MARK: - CBPeripheralDelegate

extension G2: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices _: Error?) {
        guard let services = peripheral.services else { return }
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
        error _: Error?
    ) {
        guard let characteristics = service.characteristics else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let side = peripheral === self.leftPeripheral ? "LEFT" : "RIGHT"

            for char in characteristics {
                let uuid = char.uuid
                let props = char.properties

                // Log all characteristics with their properties for debugging
                var propStr: [String] = []
                if props.contains(.read) { propStr.append("read") }
                if props.contains(.write) { propStr.append("write") }
                if props.contains(.writeWithoutResponse) { propStr.append("writeNoResp") }
                if props.contains(.notify) { propStr.append("notify") }
                if props.contains(.indicate) { propStr.append("indicate") }
                Bridge.log("G2: \(side) char \(uuid) props=[\(propStr.joined(separator: ","))]")

                if uuid == G2BLE.CHAR_WRITE {
                    Bridge.log("G2: Found WRITE char on \(side)")
                    if peripheral === self.leftPeripheral {
                        self.leftWriteChar = char
                    } else {
                        self.rightWriteChar = char
                    }
                } else if uuid == G2BLE.CHAR_NOTIFY {
                    Bridge.log("G2: Found NOTIFY char on \(side)")
                    if peripheral === self.leftPeripheral {
                        self.leftNotifyChar = char
                    } else {
                        self.rightNotifyChar = char
                    }
                    peripheral.setNotifyValue(true, for: char)
                } else if uuid == G2BLE.AUDIO_NOTIFY {
                    Bridge.log("G2: Found AUDIO char on \(side)")
                    if peripheral === self.leftPeripheral {
                        self.leftAudioChar = char
                    } else {
                        self.rightAudioChar = char
                    }
                    peripheral.setNotifyValue(true, for: char)
                }
            }

            // Check if this side is fully initialized
            if peripheral === self.leftPeripheral && self.leftWriteChar != nil {
                self.leftInitialized = true
                Bridge.log("G2: LEFT initialized")
            } else if peripheral === self.rightPeripheral && self.rightWriteChar != nil
                && self.rightNotifyChar != nil
            {
                self.rightInitialized = true
                Bridge.log("G2: RIGHT initialized")
            }

            // Both sides ready -> run auth (once)
            if self.leftInitialized && self.rightInitialized && !self.authStarted {
                self.authStarted = true
                Bridge.log("G2: Both sides initialized, starting auth sequence")
                Task { await self.runAuthSequence() }
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let data = characteristic.value, error == nil else { return }

        Task { @MainActor [weak self] in
            guard let self = self else { return }

            if characteristic.uuid == G2BLE.AUDIO_NOTIFY {
                // Audio data - forward to mic system
                await self.handleAudioData(data)
            } else if characteristic.uuid == G2BLE.CHAR_NOTIFY {
                // Protocol data
                await self.handleNotifyData(data, from: peripheral)
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didWriteValueFor _: CBCharacteristic, error: Error?
    ) {
        if let error = error {
            DispatchQueue.main.async {
                Bridge.log("G2: Write error: \(error.localizedDescription)")
            }
        }
    }
}
