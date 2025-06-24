// import { SimplePermissionChecker } from '../simple-permission-checker';
// import { PermissionType } from '@mentra/sdk';
// import { StreamType, createTranscriptionStream } from '@mentra/sdk';
// import { AppI } from '../../../models/app.model';
// import subscriptionService from '../../session/subscription.service';
// import { expect, test, describe, it, jest, mock, beforeEach } from "bun:test";

// // Mock the dependencies
// mock.module('@mentra/utils', () => ({
//   logger: {
//     info: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn(),
//     debug: jest.fn(),
//   }
// }));

// mock.module('../../../models/app.model', () => ({
//   default: {
//     findOne: jest.fn(),
//   }
// }));

// mock.module('../../session/session.service', () => ({
//   sessionService: {
//     getSession: jest.fn(),
//   }
// }));

// describe('Permission Integration Test', () => {
//   beforeEach(() => {
//     jest.clearAllMocks();

//     // Reset the subscriptions map in the subscription service
//     // @ts-ignore - accessing private property for testing
//     subscriptionService.subscriptions = new Map();
//   });

//   describe('SubscriptionService with SimplePermissionChecker', () => {
//     it('should allow subscriptions for apps with proper permissions', async () => {
//       // Mock the App model's findOne method
//       const mockApp = {
//         packageName: 'test.app',
//         permissions: [{ type: PermissionType.MICROPHONE }, { type: PermissionType.LOCATION }],
//       };

//       require('../../../models/app.model').default.findOne.mockResolvedValue(mockApp);

//       // Mock the session
//       const mockSession = {
//         appConnections: new Map(),
//       };
//       require('../../session/session.service').sessionService.getSession.mockReturnValue(mockSession);

//       // Test the updateSubscriptions method
//       await subscriptionService.updateSubscriptions(
//         'test-session',
//         'test.app',
//         'user@example.com',
//         [StreamType.AUDIO_CHUNK, StreamType.LOCATION_UPDATE, StreamType.BUTTON_PRESS]
//       );

//       // Get the subscriptions
//       const subs = subscriptionService.getAppSubscriptions('test-session', 'test.app');

//       // All subscriptions should be allowed
//       expect(subs).toContain(StreamType.AUDIO_CHUNK);
//       expect(subs).toContain(StreamType.LOCATION_UPDATE);
//       expect(subs).toContain(StreamType.BUTTON_PRESS);
//       expect(subs.length).toBe(3);
//     });

//     it('should filter out subscriptions that require undeclared permissions', async () => {
//       // Mock the App model's findOne method
//       const mockApp = {
//         packageName: 'test.app',
//         permissions: [{ type: PermissionType.LOCATION }], // Only LOCATION permission
//       };

//       require('../../../models/app.model').default.findOne.mockResolvedValue(mockApp);

//       // Mock the session with a WebSocket connection
//       const mockWs = {
//         readyState: 1,
//         send: jest.fn(),
//       };
//       const mockSession = {
//         appConnections: new Map([['test.app', mockWs]]),
//       };
//       require('../../session/session.service').sessionService.getSession.mockReturnValue(mockSession);

//       // Test the updateSubscriptions method
//       await subscriptionService.updateSubscriptions(
//         'test-session',
//         'test.app',
//         'user@example.com',
//         [StreamType.AUDIO_CHUNK, StreamType.LOCATION_UPDATE, StreamType.BUTTON_PRESS]
//       );

//       // Get the subscriptions
//       const subs = subscriptionService.getAppSubscriptions('test-session', 'test.app');

//       // AUDIO_CHUNK should be filtered out (needs MICROPHONE)
//       // LOCATION_UPDATE should be allowed (has LOCATION)
//       // BUTTON_PRESS should be allowed (no permission required)
//       expect(subs).not.toContain(StreamType.AUDIO_CHUNK);
//       expect(subs).toContain(StreamType.LOCATION_UPDATE);
//       expect(subs).toContain(StreamType.BUTTON_PRESS);
//       expect(subs.length).toBe(2);

//       // Check that an error message was sent to the WebSocket
//       expect(mockWs.send).toHaveBeenCalled();
//       const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
//       expect(sentMessage.type).toBe('permission_error');
//       expect(sentMessage.details.length).toBe(1);
//       expect(sentMessage.details[0].stream).toBe(StreamType.AUDIO_CHUNK);
//       expect(sentMessage.details[0].requiredPermission).toBe(PermissionType.MICROPHONE);
//     });

//     it('should handle language-specific streams correctly', async () => {
//       // Mock the App model's findOne method
//       const mockApp = {
//         packageName: 'test.app',
//         permissions: [{ type: PermissionType.MICROPHONE }],
//       };

//       require('../../../models/app.model').default.findOne.mockResolvedValue(mockApp);

//       // Mock the session
//       const mockSession = {
//         appConnections: new Map(),
//       };
//       require('../../core/session.service').sessionService.getSession.mockReturnValue(mockSession);

//       // Test with language-specific transcription stream
//       const transcriptionStream = createTranscriptionStream('en-US');

//       await subscriptionService.updateSubscriptions(
//         'test-session',
//         'test.app',
//         'user@example.com',
//         [transcriptionStream]
//       );

//       // Get the subscriptions
//       const subs = subscriptionService.getAppSubscriptions('test-session', 'test.app');

//       // The language-specific stream should be allowed
//       expect(subs).toContain(transcriptionStream);
//       expect(subs.length).toBe(1);
//     });

//     it('should gracefully handle the case when app is not found', async () => {
//       // Mock the App model's findOne method to return null (app not found)
//       require('../../../models/app.model').default.findOne.mockResolvedValue(null);

//       // Test the updateSubscriptions method
//       await subscriptionService.updateSubscriptions(
//         'test-session',
//         'nonexistent.app',
//         'user@example.com',
//         [StreamType.BUTTON_PRESS]
//       );

//       // Get the subscriptions - they should be allowed due to the fallback behavior
//       const subs = subscriptionService.getAppSubscriptions('test-session', 'nonexistent.app');

//       // The subscription should still be set due to the try/catch error handling
//       expect(subs).toContain(StreamType.BUTTON_PRESS);
//       expect(subs.length).toBe(1);
//     });
//   });
// });