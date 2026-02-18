/**
 * Test data for Gallery development and testing
 * Provides dummy images and videos for testing the MediaViewer component
 */

import {PhotoInfo} from "@/types/asg"

// Public test images and videos for development
export const TEST_GALLERY_ITEMS: PhotoInfo[] = [
  // Test Images
  {
    name: "test_image_1.jpg",
    url: "https://picsum.photos/800/600?random=1",
    download: "https://picsum.photos/800/600?random=1",
    size: 245678,
    modified: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_image_2.jpg",
    url: "https://picsum.photos/800/600?random=2",
    download: "https://picsum.photos/800/600?random=2",
    size: 198234,
    modified: Date.now() - 1000 * 60 * 60 * 12, // 12 hours ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_image_3.jpg",
    url: "https://picsum.photos/600/800?random=3",
    download: "https://picsum.photos/600/800?random=3",
    size: 287456,
    modified: Date.now() - 1000 * 60 * 60 * 6, // 6 hours ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_image_4.jpg",
    url: "https://picsum.photos/800/600?random=4",
    download: "https://picsum.photos/800/600?random=4",
    size: 312890,
    modified: Date.now() - 1000 * 60 * 60 * 3, // 3 hours ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_image_5.jpg",
    url: "https://picsum.photos/800/600?random=5",
    download: "https://picsum.photos/800/600?random=5",
    size: 267123,
    modified: Date.now() - 1000 * 60 * 60 * 2, // 2 hours ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  // Test Videos (using sample video URLs)
  {
    name: "test_video_1.mp4",
    url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    download: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    size: 1567890,
    modified: Date.now() - 1000 * 60 * 60, // 1 hour ago
    mime_type: "video/mp4",
    is_video: true,
    glassesModel: "G1",
  },
  {
    name: "test_image_6.jpg",
    url: "https://picsum.photos/800/600?random=6",
    download: "https://picsum.photos/800/600?random=6",
    size: 223456,
    modified: Date.now() - 1000 * 60 * 30, // 30 minutes ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_video_2.mp4",
    url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    download: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    size: 2345678,
    modified: Date.now() - 1000 * 60 * 15, // 15 minutes ago
    mime_type: "video/mp4",
    is_video: true,
    glassesModel: "G1",
  },
  {
    name: "test_image_7.jpg",
    url: "https://picsum.photos/600/800?random=7",
    download: "https://picsum.photos/600/800?random=7",
    size: 289345,
    modified: Date.now() - 1000 * 60 * 10, // 10 minutes ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
  {
    name: "test_image_8.jpg",
    url: "https://picsum.photos/800/600?random=8",
    download: "https://picsum.photos/800/600?random=8",
    size: 256789,
    modified: Date.now() - 1000 * 60 * 5, // 5 minutes ago
    mime_type: "image/jpeg",
    is_video: false,
    glassesModel: "G1",
  },
]

/**
 * Enable or disable test data injection
 * Set to true to show test images/videos in gallery
 */
export const ENABLE_TEST_GALLERY_DATA = false // Only in development mode
