//
//  CoreCommsService.swift
//  AOS
//
//  Created by Matthew Fosse on 3/4/25.
//

import Foundation
import React

@objc(CoreCommsService)
class CoreCommsService: RCTEventEmitter {

  public static var emitter: RCTEventEmitter!

  override init() {
    super.init()
    CoreCommsService.emitter = self
  }
  
  @objc
  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String] {
    // add more as needed
    return ["onReady", "onPending", "onFailure", "onConnectionStateChanged", "CoreMessageIntentEvent", "CoreMessageEvent"]
  }
}
