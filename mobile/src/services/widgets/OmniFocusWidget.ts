import { BaseWidget, WidgetData } from './Widget';
import { mpCliBridge } from '../MpCliBridge';
import DisplayFormatter from '../DisplayFormatter';

interface OmniFocusData extends WidgetData {
  task?: string;
  priority?: number;
  project?: string;
  context?: string;
}

export class OmniFocusWidget extends BaseWidget {
  id = 'omnifocus';
  name = 'OmniFocus Tasks';
  refreshInterval = 60; // seconds

  async fetchData(): Promise<OmniFocusData> {
    try {
      const response = await mpCliBridge.executeCommand('next');
      
      if (response.success && response.data) {
        return response.data as OmniFocusData;
      }
      
      return {};
    } catch (error) {
      console.error('[OmniFocusWidget] Error fetching data:', error);
      return {};
    }
  }

  formatDisplay(data: OmniFocusData): string {
    return DisplayFormatter.formatNext(data);
  }
}
