import { BaseWidget, WidgetData } from './Widget';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  version = '1.1.0'; // Track widget version - bump to force script update
  
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
        savedText = 'Hi Doug, great to connect with you today. I\'m excited to discuss the EMR integration for Nodes Bio. I have the MentraOS dashboard running on my Even Realities G1 glasses right now. As you can see, we\'ve built a fully offline system that displays real-time data contextually based on head position. For your EMR integration, we can pull patient data, vitals, and notes directly onto the glasses, allowing clinicians to stay hands-free while accessing critical information. The system works completely offline and untethered, which is perfect for clinical environments. I\'d love to show you how we can customize this for Nodes Bio\'s specific workflows. What aspects of the EMR integration are most important to you? --- LATIN VOCABULARY --- Carpe diem: Seize the day. Memento mori: Remember you must die. Veni vidi vici: I came, I saw, I conquered. Cogito ergo sum: I think, therefore I am. Per aspera ad astra: Through hardships to the stars. Amor vincit omnia: Love conquers all. Tempus fugit: Time flies. Ars longa vita brevis: Art is long, life is short. Audentes fortuna iuvat: Fortune favors the bold. Festina lente: Make haste slowly.';
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
