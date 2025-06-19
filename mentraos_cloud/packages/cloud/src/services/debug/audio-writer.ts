import * as fs from 'fs';
import * as path from 'path';

export class AudioWriter {
  private readonly dirPath: string;
  private readonly userId: string;
  private readonly wavFilePath: string;
  private totalWavBytesWritten: number = 0;
  
  // Audio format parameters
  private readonly sampleRate: number = 16000; // 16kHz
  private readonly numChannels: number = 1;    // Mono
  private readonly bitsPerSample: number = 16; // 16-bit PCM

  constructor(userId: string, dirPath: string = path.join(process.cwd(), 'audio-logs')) {
    this.userId = userId;
    this.dirPath = dirPath;
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    // Initialize WAV file
    this.wavFilePath = path.join(dirPath, `${userId}_audio.wav`);
    this.initializeWavFile();
  }

  private initializeWavFile(): void {
    // Create a new WAV file with just the header
    const headerBuffer = this.createWavHeader(0);
    fs.writeFileSync(this.wavFilePath, headerBuffer);
  }

  private createWavHeader(dataSize: number): Buffer {
    const buffer = Buffer.alloc(44);
    
    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    
    // "fmt " sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
    buffer.writeUInt16LE(this.numChannels, 22);
    buffer.writeUInt32LE(this.sampleRate, 24);
    buffer.writeUInt32LE(this.sampleRate * this.numChannels * this.bitsPerSample / 8, 28); // ByteRate
    buffer.writeUInt16LE(this.numChannels * this.bitsPerSample / 8, 32); // BlockAlign
    buffer.writeUInt16LE(this.bitsPerSample, 34);
    
    // "data" sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    
    return buffer;
  }

  private updateWavHeader(): void {
    try {
      // Create a new header with the updated size
      const headerBuffer = this.createWavHeader(this.totalWavBytesWritten);
      
      // Write the updated header back to the file
      const fd = fs.openSync(this.wavFilePath, 'r+');
      fs.writeSync(fd, headerBuffer, 0, 44, 0);
      fs.closeSync(fd);
    } catch (error) {
      console.error('Error updating WAV header:', error);
    }
  }

  /**
   * Writes raw LC3 audio data to a file
   */
  async writeLC3(audioData: ArrayBuffer): Promise<void> {
    try {
      // Save raw LC3 data to file
      const filePath = path.join(this.dirPath, `${this.userId}_lc3.raw`);
      await fs.promises.appendFile(filePath, Buffer.from(audioData));
    } catch (error) {
      console.error('Error writing LC3 audio data:', error);
    }
  }

  /**
   * Writes PCM audio data to both a raw file and the WAV file
   */
  async writePCM(audioData: ArrayBuffer): Promise<void> {
    try {
      const buffer = Buffer.from(audioData);
      
      // Save raw PCM data to file
      const rawFilePath = path.join(this.dirPath, `${this.userId}_pcm.raw`);
      await fs.promises.appendFile(rawFilePath, buffer);
      
      // Append to WAV file
      await fs.promises.appendFile(this.wavFilePath, buffer);
      this.totalWavBytesWritten += buffer.length;
      
      // Update WAV header with new size
      this.updateWavHeader();
    } catch (error) {
      console.error('Error writing PCM audio data:', error);
    }
  }
}