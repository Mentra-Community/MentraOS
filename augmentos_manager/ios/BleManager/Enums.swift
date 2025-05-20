//
//  File.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/3/25.
//

import Foundation



enum CommandResponse: UInt8 {
  case ACK = 0xC9
}

enum Commands: UInt8 {
  case BLE_EXIT_ALL_FUNCTIONS = 0x18
  case BLE_REQ_INIT = 0x4D
  case BLE_REQ_HEARTBEAT = 0x2C
  case BLE_REQ_EVENAI = 0x4E
  case BLE_REQ_TRANSFER_MIC_DATA = 0xF1
  case BLE_REQ_DEVICE_ORDER = 0xF5
  case BLE_REQ_MIC_ON = 0x0E
  case QUICK_NOTE_ADD = 0x1E
//  case BATTERY_STATUS = 0x2C
  case BRIGHTNESS = 0x01
  case WHITELIST = 0x04
  case SILENT_MODE = 0x03
  case DASHBOARD_LAYOUT_COMMAND = 0x26
  case DASHBOARD_SHOW = 0x06
  case HEAD_UP_ANGLE = 0x0B
  case UNK_2 = 0x39
  case UNK_1 = 0x50
}

enum DeviceOrders: UInt8 {
  case DISPLAY_READY = 0x00
  case TRIGGER_CHANGE_PAGE = 0x01
  case TRIGGER_FOR_AI = 0x17
  case TRIGGER_FOR_STOP_RECORDING = 0x18
  case G1_IS_READY = 0x09
  case HEAD_UP = 0x1e
  case HEAD_DOWN = 0x1f
  case SILENCED = 0x04
  case ACTIVATED = 0x05
  case HEAD_UP2 = 0x02
  case HEAD_DOWN2 = 0x03
  case CASE_OPEN = 0x08
  case CASE_CLOSED = 0x0B
  case CASE_CHARGING_STATUS = 0x0E
  case CASE_CHARGE_INFO = 0x0F
  case DOUBLE_TAP = 0x20
}

enum DisplayStatus: UInt8 {
  case NORMAL_TEXT = 0x30
  case FINAL_TEXT = 0x40
  case MANUAL_PAGE = 0x50
  case ERROR_TEXT = 0x60
  case SIMPLE_TEXT = 0x70
}

public enum DashboardHeight: UInt8 {
  case position0 = 0x00  // Bottom
  case position1 = 0x01
  case position2 = 0x02
  case position3 = 0x03
  case position4 = 0x04
  case position5 = 0x05
  case position6 = 0x06
  case position7 = 0x07
  case position8 = 0x08  // Top
}

public enum DashboardDepth: UInt8 {
  case position0 = 0x00  // Bottom
  case position1 = 0x01
  case position2 = 0x02
  case position3 = 0x03
  case position4 = 0x04
  case position5 = 0x05
  case position6 = 0x06
  case position7 = 0x07
  case position8 = 0x08
  case position9 = 0x09
}

public enum DashboardMode: UInt8 {
  case full = 0x00
  case dual = 0x01
  case minimal = 0x02
}
