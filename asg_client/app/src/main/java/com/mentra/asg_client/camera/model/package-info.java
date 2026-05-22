/**
 * Photo capture request DTOs for {@link com.mentra.asg_client.camera.CameraNeoService}.
 *
 * <p>Two-phase model:
 * <ol>
 *   <li>{@link QueuedPhotoRequest} — job waiting in {@link QueuedPhotoRequestQueue}</li>
 *   <li>{@link ActivePhotoCapture} — immutable snapshot while
 *       {@link com.mentra.asg_client.camera.lifecycle.PhotoSession} runs AE/capture</li>
 * </ol>
 */
package com.mentra.asg_client.camera.model;
