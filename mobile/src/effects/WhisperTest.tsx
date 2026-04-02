// import React, {useEffect, useState} from "react"
// import {Text, Button, View} from "react-native"
// import {useSpeechToText, WHISPER_TINY, WHISPER_TINY_EN} from "react-native-executorch"
// import CoreModule from "core"

// // const decodePcm16Base64ToFloat32 = (base64: string): Float32Array => {
// //   const binaryString = atob(base64)
// //   const byteLength = binaryString.length
// //   const sampleCount = Math.floor(byteLength / 2)
// //   const samples = new Float32Array(sampleCount)

// //   for (let i = 0; i < sampleCount; i++) {
// //     const low = binaryString.charCodeAt(i * 2)
// //     const high = binaryString.charCodeAt(i * 2 + 1)
// //     let sample = (high << 8) | low
// //     if (sample >= 0x8000) {
// //       sample -= 0x10000
// //     }
// //     samples[i] = sample / 0x8000
// //   }

// //   return samples
// // }

// const decodePcm16ToFloat32 = (input: ArrayBuffer | ArrayBufferLike): Float32Array => {
//     const buffer = input instanceof ArrayBuffer ? input : new Uint8Array(input as any).buffer;
//     const view = new DataView(buffer);
//     const sampleCount = Math.floor(buffer.byteLength / 2);
//     const samples = new Float32Array(sampleCount);

//     for (let i = 0; i < sampleCount; i++) {
//       const sample = view.getInt16(i * 2, true);
//       samples[i] = sample / 0x8000;
//     }

//     return samples;
//   };

// export default function WhisperTest() {
//   const model = useSpeechToText({
//     model: WHISPER_TINY,
//     preventLoad: false,
//   })

//   const handleStartStreamingTranscribe = async () => {
//     console.log("COMPOSITOR: Starting audio recorder")
//     console.log("COMPOSITOR: Download progress:", model.downloadProgress)

//     // recorder.onAudioReady({
//     //   sampleRate: 16000,
//     //   bufferLength: 1600,
//     //   channelCount: 1,
//     // }, ({ buffer }) => {
//     //   console.log("COMPOSITOR: Received audio buffer:", buffer);
//     //   model.streamInsert(buffer.getChannelData(0));
//     // });
//     // let res = recorder.start({ fileNameOverride: "test.wav" });
//     // console.log("COMPOSITOR: Started audio recorder:", res);

//     // console.log("COMPOSITOR: Is recording:", recorder.isRecording());

//     await CoreModule.update("core", {
//       should_send_pcm: true,
//     })

//     // await sttModule.load(WHISPER_TINY_EN, (progress) => {
//     //   console.log("COMPOSITOR: Loading model...", progress)
//     // })

//     // setInterval(async () => {
//     //   // console.log("COMPOSITOR: Streaming transcription...")
//     //   console.log("COMPOSITOR: Transcription result:", model.downloadProgress)
//     // }, 1000)

//     const pcmSub = CoreModule.addListener("mic_pcm", (event) => {
//       // console.log("COMPOSITOR: Received mic pcm:", event.base64)
//       //   const samples = decodePcm16Base64ToFloat32(event.base64)
//       //   let samples = new Float32Array(event.pcm)
//       //   model.streamInsert(samples)
//       model.streamInsert(decodePcm16ToFloat32(event.pcm))

//       //   model.streamInsert(samples)
//     })

//     try {
//       await model.stream({
//         language: "zh",
//       })
//     } catch (error) {
//       console.error("Error during streaming transcription:", error)
//     }
//   }

//   const handleStopStreamingTranscribe = () => {
//     model.streamStop()
//   }

//   return (
//     <View className="flex-1 items-center justify-center z-100 absolute inset-0 bg-background">
//       <Text className="text-white text-2xl font-bold">
//         {model.committedTranscription}
//         {model.nonCommittedTranscription}
//       </Text>
//       <Button onPress={handleStartStreamingTranscribe} title="Start Streaming" />
//       <Button onPress={handleStopStreamingTranscribe} title="Stop Streaming" />
//     </View>
//   )
// }
