// public/audio-processor.js

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs, outputs, parameters) {
    // Assume mono input.
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }
    const inputChannel = input[0];

    // Convert float samples to 16-bit PCM.
    const buffer = new ArrayBuffer(inputChannel.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < inputChannel.length; i++) {
      let sample = inputChannel[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    }

    // Send the processed buffer to the main thread.
    this.port.postMessage(buffer, [buffer]);

    // (Optional) pass the audio through so you can hear it.
    // const output = outputs[0];
    // if (output && output.length > 0) {
    //   for (let channel = 0; channel < output.length; channel++) {
    //     output[channel].set(input[channel]);
    //   }
    // }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
