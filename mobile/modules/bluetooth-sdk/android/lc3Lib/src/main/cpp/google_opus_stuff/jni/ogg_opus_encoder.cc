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

#include "ogg_opus_encoder.h"
#include <jni.h>
#include <cassert>
#include <cstdint>
#include "../ogg_opus_encoder.h"

namespace {

using audio_util::OggOpusEncoder;

OggOpusEncoder* GetInstanceOrDie(jlong ptr) {
  assert(ptr);
  return reinterpret_cast<OggOpusEncoder*>(ptr);
}

bool VerifyInitialized(const std::string& function_name, jlong instance_ptr) {
  if (instance_ptr == 0) {
    fprintf(stderr, "%s called prior to allocate() or after destroy()!\n",
            function_name.c_str());
    return false;
  }
  OggOpusEncoder* instance = GetInstanceOrDie(instance_ptr);
  if (instance == nullptr) {
    fprintf(stderr, "%s called prior to init()!\n", function_name.c_str());
    return false;
  }
  return true;
}

JNIEXPORT jbyteArray convertToByteArray(const std::vector<unsigned char>& data,
                                        JNIEnv* env) {
  jbyteArray byteArray = env->NewByteArray(data.size());
  env->SetByteArrayRegion(byteArray, 0, data.size(),
                          reinterpret_cast<const jbyte*>(data.data()));
  return byteArray;
}

}  // namespace

JNIEXPORT jlong JNICALL JNI_METHOD(init)(JNIEnv* env, jobject instance,
                                         jint num_channels,
                                         jint bitrate_bits_per_second,
                                         jint sample_rate_hz,
                                         jboolean use_vbr) {
  constexpr bool low_latency_mode = true;
  return reinterpret_cast<jlong>(new OggOpusEncoder(
      num_channels, sample_rate_hz, bitrate_bits_per_second, use_vbr,
      low_latency_mode));
}

JNIEXPORT jbyteArray JNICALL
JNI_METHOD(processAudioBytes)(JNIEnv* env, jobject instance, jlong instance_ptr,
                              jbyteArray samples, jint offset, jint length) {
  if (!VerifyInitialized("processAudioBytes", instance_ptr)) {
    return convertToByteArray(std::vector<unsigned char>(0), env);
  }
  jsize array_length_bytes = length;
  if (!array_length_bytes) {
    fprintf(stdout, "Found empty array\n");
  }
  assert(array_length_bytes % 2 == 0 && "int16 formatted stream missing bytes!");
  std::vector<int16_t> pcm(array_length_bytes / 2);
  env->GetByteArrayRegion(samples, offset, array_length_bytes,
                          reinterpret_cast<jbyte*>(pcm.data()));
  if (env->ExceptionOccurred()) {
    fprintf(stderr, "Exception occurred in java Environment object\n");
  }

  return convertToByteArray(GetInstanceOrDie(instance_ptr)->Process(pcm), env);
}

JNIEXPORT jbyteArray JNICALL JNI_METHOD(flush)(JNIEnv* env, jobject instance,
                                               jlong instance_ptr) {
  return convertToByteArray(GetInstanceOrDie(instance_ptr)->Flush(), env);
}

JNIEXPORT void JNICALL JNI_METHOD(free)(JNIEnv* env, jobject instance,
                                        jlong instance_ptr) {
  delete reinterpret_cast<OggOpusEncoder*>(instance_ptr);
}
