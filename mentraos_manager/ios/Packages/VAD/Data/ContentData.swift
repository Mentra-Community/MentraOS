////
////  ContentViewModel.swift
////  ios-vad
////
////  Created by baochuquan on 2024/11/9.
////
//
//import Foundation
//
//@Observable
//class ContentData {
//    var selection: VADType = .webrtc
//
//    var vadData: [VADData] = [.webrtc, .silero, .yamnet]
//}
//
//@Observable
//class VADData: Identifiable {
//    
//    var type: VADType
//    var result: VADResult
//    var record: VADRecord
//    var sampleRate: SampleRateConfiguration
//    var frameSize: FrameSizeConfiguration
//    var quality: QualityConfiguration
//    var isError: Bool = false
//
//    var id: String {
//        type.rawValue
//    }
//
//    static let webrtc = VADData(type: .webrtc, result: .idle, record: .idle, sampleRate: .webrtc, frameSize: SampleRateConfiguration.webrtc.frameSizeConfiguration(type: .webrtc), quality: .webrtc)
//    static let silero = VADData(type: .silero, result: .idle, record: .idle, sampleRate: .silero, frameSize: SampleRateConfiguration.silero.frameSizeConfiguration(type: .silero), quality: .silero)
//    static let yamnet = VADData(type: .yamnet, result: .idle, record: .idle, sampleRate: .yamnet, frameSize: SampleRateConfiguration.yamnet.frameSizeConfiguration(type: .yamnet), quality: .yamnet)
//    
//    init(type: VADType, result: VADResult, record: VADRecord, sampleRate: SampleRateConfiguration, frameSize: FrameSizeConfiguration, quality: QualityConfiguration) {
//        self.type = type
//        self.result = result
//        self.record = record
//        self.sampleRate = sampleRate
//        self.frameSize = frameSize
//        self.quality = quality
//    }
//
//    func startRecord() {
//        Permission.requestMicrophonePermission { [weak self] result in
//            guard let self = self else { return }
//            guard result.granted else {
//                fatalError()
//            }
//            OpenMicProvider.shared.startRecord(type: self.type, sampleRate: self.sampleRate.selectedOption, frameSize: self.frameSize.selectedOption, quality: self.quality.selectedOption) { [weak self] state in
//                if state == .start || state == .speeching {
//                    self?.result = .speech
//                }
//                if state == .end || state == .silence {
//                    self?.result = .silence
//                }
//            }
//        }
//        record = .work
//        result = .silence
//    }
//
//    func stopRecord() {
//        OpenMicProvider.shared.stopRecord()
//        record = .idle
//        result = .idle
//    }
//
//    func recordError() {
//        stopRecord()
//        isError = true
//    }
//}
