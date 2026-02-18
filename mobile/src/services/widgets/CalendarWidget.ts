import { BaseWidget, WidgetData } from './Widget';
import DisplayFormatter from '../DisplayFormatter';
import * as Calendar from 'expo-calendar';

interface CalendarEvent {
  title?: string;
  start?: string;
  end?: string;
  timeUntil?: string;
}

interface CalendarData extends WidgetData {
  events?: CalendarEvent[];
  output?: string;
}

export class CalendarWidget extends BaseWidget {
  id = 'calendar';
  name = 'Calendar';
  refreshInterval = 300; // 5 minutes

  async fetchData(): Promise<CalendarData> {
    // Temporarily suppress console.log during calendar fetch
    const originalLog = console.log;
    console.log = () => {};
    
    try {
      // Request calendar permissions
      const { status } = await Calendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        console.log = originalLog;
        return { output: 'Calendar permission denied' };
      }

      // Get today's events
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const events = await Calendar.getEventsAsync(
        calendars.map(c => c.id),
        startOfDay,
        endOfDay
      );

      // Sort by start time
      const sortedEvents = events
        .filter(e => e.startDate)
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

      console.log = originalLog;
      return {
        events: sortedEvents.map(e => ({
          title: e.title,
          start: e.startDate,
          end: e.endDate,
        })),
      };
    } catch (error) {
      console.log = originalLog;
      // console.error('[CalendarWidget] Error fetching data:', error);
      return {};
    }
  }

  formatDisplay(data: CalendarData): string {
    if (!data.output && (!data.events || data.events.length === 0)) {
      return this.formatEmpty();
    }

    // If we have raw output, parse it
    if (data.output) {
      return this.formatFromOutput(data.output);
    }

    // Otherwise format from structured events
    return this.formatFromEvents(data.events || []);
  }

  private formatEmpty(): string {
    const lines = [
      '📅 TODAY',
      'No events scheduled',
      '',
      'Free day ahead!',
      ''
    ];
    return lines.join('\n');
  }

  private formatFromOutput(output: string): string {
    const lines: string[] = [];
    
    // Parse the output to find next event
    const eventMatch = output.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(.+)/);
    
    if (eventMatch) {
      const time = eventMatch[1];
      const title = eventMatch[2].split('\n')[0].trim();
      
      lines.push('📅 TODAY');
      lines.push(`${time} - ${DisplayFormatter['truncate'](title, 30)}`);
      
      // Try to calculate time until
      const now = new Date();
      const eventTime = this.parseTime(time);
      if (eventTime) {
        const diff = eventTime.getTime() - now.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        
        if (minutes > 0) {
          if (hours > 0) {
            lines.push(`In ${hours}h ${minutes % 60}m`);
          } else {
            lines.push(`In ${minutes}m`);
          }
        } else {
          lines.push('Now');
        }
      } else {
        lines.push('');
      }
      
      // Count remaining events
      const eventCount = (output.match(/\d{1,2}:\d{2}\s*[AP]M/g) || []).length;
      if (eventCount > 1) {
        lines.push(`${eventCount - 1} more today`);
      } else {
        lines.push('');
      }
    } else {
      return this.formatEmpty();
    }

    // Pad to 5 lines
    while (lines.length < 5) {
      lines.push('');
    }

    return lines.slice(0, 5).join('\n');
  }

  private formatFromEvents(events: CalendarEvent[]): string {
    if (events.length === 0) {
      return this.formatEmpty();
    }

    const lines: string[] = [];
    const nextEvent = events[0];
    
    lines.push('📅 TODAY');
    lines.push(DisplayFormatter['truncate'](nextEvent.title || 'Untitled', 40));
    
    if (nextEvent.timeUntil) {
      lines.push(nextEvent.timeUntil);
    } else if (nextEvent.start) {
      lines.push(nextEvent.start);
    } else {
      lines.push('');
    }
    
    if (events.length > 1) {
      lines.push(`${events.length - 1} more today`);
    } else {
      lines.push('');
    }

    // Pad to 5 lines
    while (lines.length < 5) {
      lines.push('');
    }

    return lines.slice(0, 5).join('\n');
  }

  private parseTime(timeStr: string): Date | null {
    try {
      const match = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)/);
      if (!match) return null;

      let hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const period = match[3];

      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;

      const now = new Date();
      const eventTime = new Date(now);
      eventTime.setHours(hours, minutes, 0, 0);

      return eventTime;
    } catch {
      return null;
    }
  }
}
