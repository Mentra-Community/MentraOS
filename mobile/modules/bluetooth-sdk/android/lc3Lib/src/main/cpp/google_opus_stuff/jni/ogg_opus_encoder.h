/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef AUDIO_UTIL_JNI_OGG_OPUS_ENCODER_H_
#define AUDIO_UTIL_JNI_OGG_OPUS_ENCODER_H_

#include <jni.h>

// https://stackoverflow.com/questions/25363027/jni-getmethodid-not-working-for-constructor-of-inner-class
#define JNI_METHOD(fn) \
  Java_com_augmentos_smartglassesmanager_speechrecognition_google_asr_asrhelpers_StreamingAudioEncoder_00024OggOpusEncoder_##fn  // NOLINT

extern "C" {
// Create opus encoder instance. The pointer is returned in a
// jlong. Remember to call destroy with the returned value when you're done.
JNIEXPORT jlong JNICALL JNI_METHOD(init)(JNIEnv* env,
                                         jobject instance,
                                         jint num_channels,
                                         jint bitrate_bits_per_second,
                                         jint sample_rate_hz,
                                         jboolean use_vbr);

// samples must be an even number of bytes, as it represents 16-bit audio data.
JNIEXPORT jbyteArray JNICALL JNI_METHOD(processAudioBytes)(JNIEnv* env,
                                                           jobject instance,
                                                           jlong instance_ptr,
                                                           jbyteArray samples,
                                                           jint offset,
                                                           jint length);

// Tell the encoder that there will be no more samples.
JNIEXPORT jbyteArray JNICALL JNI_METHOD(flush)(JNIEnv* env, jobject instance,
                                               jlong instance_ptr);

// Releases all resources.
JNIEXPORT void JNICALL JNI_METHOD(free)(JNIEnv* env, jobject instance,
    jlong instance_ptr);

}  // extern "C"
#endif  // AUDIO_UTIL_JNI_OGG_OPUS_ENCODER_H_
