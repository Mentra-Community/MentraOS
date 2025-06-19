// @augmentos/utils/src/audio/AudioProcessor.ts

import { Transform, TransformCallback } from 'stream';

export interface AudioProcessorConfig {
  threshold: number;      // dB threshold where compression begins (-24 default)
  ratio: number;         // Compression ratio (3:1 default)
  attack: number;        // Attack time in ms (5ms default)
  release: number;       // Release time in ms (50ms default)
  gainDb: number;        // Output gain in dB (16 default)
  sampleRate: number;    // Sample rate (default 16000)
  channels: number;      // Number of channels (1 for mono)
}

export class AudioProcessor extends Transform {
  private config: AudioProcessorConfig;
  private envelope: number = 0.0;
  private lastGain: number = 1.0;
  
  // Pre-calculated coefficients
  private attackCoeff: number = 0;
  private releaseCoeff: number = 0;
  private gainMultiplier: number = 1;
  private thresholdLevel: number = 0;

  constructor(config: Partial<AudioProcessorConfig> = {}) {
    super({
      // Set high water mark low for minimal latency
      highWaterMark: 1024,
      objectMode: false
    });

    this.config = {
      threshold: -24,
      ratio: 3,
      attack: 5,
      release: 50,
      gainDb: 16,
      sampleRate: 16000,
      channels: 1,
      ...config
    };

    this.updateCoefficients();
  }

  private updateCoefficients(): void {
    // Convert time constants to per-sample coefficients
    this.attackCoeff = Math.exp(-1.0 / (this.config.sampleRate * this.config.attack / 1000));
    this.releaseCoeff = Math.exp(-1.0 / (this.config.sampleRate * this.config.release / 1000));
    
    // Convert dB values to linear
    this.gainMultiplier = Math.pow(10, this.config.gainDb / 20);
    this.thresholdLevel = Math.pow(10, this.config.threshold / 20);
  }

  _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
    // Convert buffer to Int16Array for processing
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
    
    // Process each sample
    for (let i = 0; i < samples.length; i += this.config.channels) {
      // Convert to float (-1 to 1)
      let sample = samples[i] / 32768;

      // Calculate envelope (peak detection)
      const inputLevel = Math.abs(sample);
      if (inputLevel > this.envelope) {
        this.envelope = this.envelope * this.attackCoeff + inputLevel * (1 - this.attackCoeff);
      } else {
        this.envelope = this.envelope * this.releaseCoeff + inputLevel * (1 - this.releaseCoeff);
      }

      // Calculate gain reduction
      let gainReduction = 1.0;
      if (this.envelope > this.thresholdLevel) {
        gainReduction = Math.pow(this.envelope / this.thresholdLevel, 1 / this.config.ratio - 1);
      }

      // Smooth gain changes
      this.lastGain = gainReduction;

      // Apply compression and gain
      sample *= gainReduction * this.gainMultiplier;

      // Clip protection
      sample = Math.max(-1.0, Math.min(1.0, sample));

      // Convert back to int16
      samples[i] = Math.round(sample * 32767);

      // Handle stereo if needed
      if (this.config.channels === 2 && i + 1 < samples.length) {
        samples[i + 1] = samples[i];
      }
    }

    // Push processed samples
    callback(null, Buffer.from(samples.buffer));
  }

  updateConfig(newConfig: Partial<AudioProcessorConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig
    };
    
    this.updateCoefficients();
  }
}

// Helper function to create a pre-configured processor
export function createAudioProcessor(config?: Partial<AudioProcessorConfig>): AudioProcessor {
  return new AudioProcessor(config);
}