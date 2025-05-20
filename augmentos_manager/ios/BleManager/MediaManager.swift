//
// MediaManager.swift
// AugmentOS_Manager
//
// Created by Matthew Fosse on 5/13/25.
//

import Foundation
import MediaPlayer

class MediaManager: NSObject {
    private let nowPlayingInfoCenter = MPNowPlayingInfoCenter.default()
    private var mediaChangedCallback: (() -> Void)?
    private var currentMedia: [String: Any]?
    
    override init() {
        super.init()
        // delay setup until after login:
        // setup()
    }
    
    public func setup() {
        // Register for notifications about now playing item changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleNowPlayingItemChanged),
            name: .MPMusicPlayerControllerNowPlayingItemDidChange,
            object: nil
        )
        
        // Begin receiving remote control events
        UIApplication.shared.beginReceivingRemoteControlEvents()
        
        // Initialize the music player
        let musicPlayer = MPMusicPlayerController.systemMusicPlayer
        musicPlayer.beginGeneratingPlaybackNotifications()
        
        print("MediaManager: Setup complete")
    }
    
    func setMediaChangedCallback(_ callback: @escaping () -> Void) {
        self.mediaChangedCallback = callback
    }
    
    // MARK: - Notification Handlers
    
    @objc private func handleNowPlayingItemChanged(notification: Notification) {
        updateCurrentMediaInfo()
    }
    
    private func updateCurrentMediaInfo() {
        let newMediaInfo = nowPlayingInfoCenter.nowPlayingInfo
        
        // Only process if media info has changed
        if !NSDictionary(dictionary: newMediaInfo ?? [:]).isEqual(to: currentMedia ?? [:]) {
            currentMedia = newMediaInfo
            
            if let media = currentMedia, !media.isEmpty {
                if let title = media[MPMediaItemPropertyTitle] as? String,
                   let artist = media[MPMediaItemPropertyArtist] as? String {
                    print("MediaManager: Now playing \"\(title)\" by \(artist)")
                }
            } else {
                print("MediaManager: No media currently playing")
            }
            
            // Notify via callback
            mediaChangedCallback?()
        }
    }
    
    // MARK: - Media Getters
    
    func getNowPlayingMediaDetails() -> [String: Any]? {
        guard let media = currentMedia, !media.isEmpty else {
            return nil
        }
        
        // Create a simplified media info dictionary with the most important details
        var mediaDetails: [String: Any] = [:]
        
        if let title = media[MPMediaItemPropertyTitle] as? String {
            mediaDetails["title"] = title
        }
        
        if let artist = media[MPMediaItemPropertyArtist] as? String {
            mediaDetails["artist"] = artist
        }
        
        if let albumTitle = media[MPMediaItemPropertyAlbumTitle] as? String {
            mediaDetails["album"] = albumTitle
        }
        
        if let duration = media[MPMediaItemPropertyPlaybackDuration] as? TimeInterval {
            mediaDetails["duration"] = duration
        }
        
        if let playbackRate = media[MPNowPlayingInfoPropertyPlaybackRate] as? Float {
            mediaDetails["isPlaying"] = (playbackRate != 0)
        }
        
        if let elapsedTime = media[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? TimeInterval {
            mediaDetails["elapsedTime"] = elapsedTime
        }
        
        // Add artwork if available
        if let artwork = media[MPMediaItemPropertyArtwork] as? MPMediaItemArtwork {
            let size = CGSize(width: 300, height: 300)
            if let image = artwork.image(at: size) {
                mediaDetails["artwork"] = image
            }
        }
        
        return mediaDetails
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
        UIApplication.shared.endReceivingRemoteControlEvents()
        MPMusicPlayerController.systemMusicPlayer.endGeneratingPlaybackNotifications()
    }
}
