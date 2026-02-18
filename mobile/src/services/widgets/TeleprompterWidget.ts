import { BaseWidget, WidgetData } from './Widget';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

interface TeleprompterData extends WidgetData {
  text?: string;
  currentLine?: number;
  totalLines?: number;
}

const STORAGE_KEY = '@teleprompter_text';
const VERSION_KEY = '@teleprompter_version';

export class TeleprompterWidget extends BaseWidget {
  id = 'teleprompter';
  name = 'Teleprompter';
  refreshInterval = 0; // Manual only
  version = '1.2.0'; // Track widget version - bump to force script update
  
  private currentLine = 0;
  private lines: string[] = [];

  async fetchData(): Promise<TeleprompterData> {
    // Temporarily suppress console.log during calendar fetch
    const originalLog = console.log;
    console.log = () => {};
    
    try {
      // Check if version changed - if so, reset script
      const savedVersion = await AsyncStorage.getItem(VERSION_KEY);
      if (savedVersion !== this.version) {
        await AsyncStorage.removeItem(STORAGE_KEY);
        await AsyncStorage.setItem(VERSION_KEY, this.version);
      }
      
      // Load saved text from storage
      let savedText = await AsyncStorage.getItem(STORAGE_KEY);
      
      if (!savedText) {
        // Default script for Nodes Bio meeting + Latin vocabulary
        savedText = 'Hi Doug, great to connect with you today. I\'m excited to discuss the EMR integration for Nodes Bio. I have the MentraOS dashboard running on my Even Realities G1 glasses right now. As you can see, we\'ve built a fully offline system that displays real-time data contextually based on head position. For your EMR integration, we can pull patient data, vitals, and notes directly onto the glasses, allowing clinicians to stay hands-free while accessing critical information. The system works completely offline and untethered, which is perfect for clinical environments. I\'d love to show you how we can customize this for Nodes Bio\'s specific workflows. What aspects of the EMR integration are most important to you? --- LATIN VOCABULARY --- Carpe diem (KAR-pay DEE-em): Seize the day. Memento mori (meh-MEN-toh MOR-ee): Remember you must die. Veni vidi vici (WEH-nee WEE-dee WEE-kee): I came, I saw, I conquered. Cogito ergo sum (KOH-gee-toh ER-goh SOOM): I think, therefore I am. Per aspera ad astra (per AS-per-ah ad AS-trah): Through hardships to the stars. Amor vincit omnia (AH-mor WIN-kit OM-nee-ah): Love conquers all. Tempus fugit (TEM-poos FOO-git): Time flies. Ars longa vita brevis (ARS LON-gah WEE-tah BREH-wis): Art is long, life is short. Audentes fortuna iuvat (ow-DEN-tays for-TOO-nah YOO-waht): Fortune favors the bold. Festina lente (fes-TEE-nah LEN-tay): Make haste slowly.';
        // Save default script
        await AsyncStorage.setItem(STORAGE_KEY, savedText);
      }

      // Split into lines that fit G1 display (~40 chars)
      this.lines = this.splitIntoLines(savedText);
      
      if (this.currentLine >= this.lines.length) {
        this.currentLine = 0; // Loop back
      }

      console.log = originalLog;
      return {
        text: savedText,
        currentLine: this.currentLine,
        totalLines: this.lines.length,
      };
    } catch (error) {
      console.log = originalLog;
      console.error('[TeleprompterWidget] Error:', error);
      return {};
    }
  }

  formatDisplay(data: TeleprompterData): string {
    // Handle empty data or no text
    if (!data || !data.text || this.lines.length === 0) {
      return [
        `TELEPROMPTER v${this.version}`,
        '',
        'No script loaded.',
        'Add text in Dashboard Controls.',
      ].join('\n');
    }

    // Show current line + next 2 lines
    const displayLines = [
      `TELEPROMPTER (${this.currentLine + 1}/${this.lines.length}) v${this.version}`,
      '',
      this.lines[this.currentLine] || '',
      this.lines[this.currentLine + 1] || '',
      this.lines[this.currentLine + 2] || '',
    ];

    return displayLines.join('\n');
  }

  // Advance to next line
  async next(): Promise<void> {
    this.currentLine++;
    if (this.currentLine >= this.lines.length) {
      this.currentLine = 0; // Loop
    }
  }

  // Go back one line
  async previous(): Promise<void> {
    this.currentLine--;
    if (this.currentLine < 0) {
      this.currentLine = Math.max(0, this.lines.length - 1);
    }
  }

  // Reset to beginning
  async reset(): Promise<void> {
    this.currentLine = 0;
  }

  // Save new script
  static async saveScript(text: string): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, text);
  }

  // Load saved script
  static async loadScript(): Promise<string | null> {
    return await AsyncStorage.getItem(STORAGE_KEY);
  }

  // Load script from file
  static async loadFromFile(): Promise<string | null> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'text/plain',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return null;

      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);
      await this.saveScript(content);
      return content;
    } catch (error) {
      console.error('[TeleprompterWidget] File load error:', error);
      return null;
    }
  }

  private splitIntoLines(text: string): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).length <= 40) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    
    if (currentLine) lines.push(currentLine);
    return lines;
  }
}
