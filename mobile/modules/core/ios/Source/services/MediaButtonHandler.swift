import Foundation
import MediaPlayer
import AVFoundation

@objc(MediaButtonHandler)
class MediaButtonHandler: NSObject {
    
    private var commandCenter: MPRemoteCommandCenter?
    
    override init() {
        super.init()
        setupRemoteCommandCenter()
    }
    
    private func setupRemoteCommandCenter() {
        // Setup audio session to intercept remote commands
        do {
            let audioSession = AVAudioSession.sharedInstance()
            // Use .playback without mixWithOthers to take exclusive control
            try audioSession.setCategory(.playback, mode: .default)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            Bridge.log("MediaButtonHandler: Audio session activated (exclusive)")
        } catch {
            Bridge.log("MediaButtonHandler: Failed to setup audio session: \(error)")
        }
        
        commandCenter = MPRemoteCommandCenter.shared()
        
        // Play/Pause
        commandCenter?.playCommand.addTarget { [weak self] event in
            self?.handleMediaButton(button: "play", type: "short")
            return .success
        }
        
        commandCenter?.pauseCommand.addTarget { [weak self] event in
            self?.handleMediaButton(button: "pause", type: "short")
            return .success
        }
        
        // Next/Previous Track
        commandCenter?.nextTrackCommand.addTarget { [weak self] event in
            self?.handleMediaButton(button: "next", type: "short")
            return .success
        }
        
        commandCenter?.previousTrackCommand.addTarget { [weak self] event in
            self?.handleMediaButton(button: "previous", type: "short")
            return .success
        }
        
        Bridge.log("MediaButtonHandler: Remote command center configured")
    }
    
    private func handleMediaButton(button: String, type: String) {
        Bridge.log("MediaButtonHandler: ⭐ Button pressed - \(button) (\(type))")
        Bridge.sendButtonPress(buttonId: button, pressType: type)
    }
    
    @objc
    func enable() {
        commandCenter?.playCommand.isEnabled = true
        commandCenter?.pauseCommand.isEnabled = true
        commandCenter?.nextTrackCommand.isEnabled = true
        commandCenter?.previousTrackCommand.isEnabled = true
        Bridge.log("MediaButtonHandler: Commands enabled - play, pause, next, previous")
    }
    
    @objc
    func disable() {
        commandCenter?.playCommand.isEnabled = false
        commandCenter?.pauseCommand.isEnabled = false
        commandCenter?.nextTrackCommand.isEnabled = false
        commandCenter?.previousTrackCommand.isEnabled = false
        Bridge.log("MediaButtonHandler: Disabled")
    }
    
    deinit {
        disable()
    }
}

@objc(MediaButtonHandlerModule)
class MediaButtonHandlerModule: NSObject {
    
    private var handler: MediaButtonHandler?
    
    @objc
    static func requiresMainQueueSetup() -> Bool {
        return true
    }
    
    @objc
    func enable() {
        Bridge.log("MediaButtonHandlerModule: enable() called")
        if handler == nil {
            Bridge.log("MediaButtonHandlerModule: Creating new handler")
            handler = MediaButtonHandler()
            Bridge.log("MediaButtonHandlerModule: Handler created")
        } else {
            Bridge.log("MediaButtonHandlerModule: Handler already exists")
        }
        handler?.enable()
        
        // Set now playing info to claim media controls
        var nowPlayingInfo = [String: Any]()
        nowPlayingInfo[MPMediaItemPropertyTitle] = "MentraOS Dashboard"
        nowPlayingInfo[MPMediaItemPropertyArtist] = "Widget Navigation"
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0
        nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = 0
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
        Bridge.log("MediaButtonHandler: Now playing info set")
    }
    
    @objc
    func disable() {
        handler?.disable()
        
        // Clear now playing info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        Bridge.log("MediaButtonHandler: Now playing info cleared")
    }
}
