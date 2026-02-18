/**
 * Base Widget interface for dashboard widgets
 */
export interface WidgetData {
  [key: string]: any;
}

export interface Widget {
  id: string;
  name: string;
  enabled: boolean;
  refreshInterval: number; // seconds

  fetchData(): Promise<WidgetData>;
  formatDisplay(data: WidgetData): string;
}

export abstract class BaseWidget implements Widget {
  abstract id: string;
  abstract name: string;
  enabled: boolean = true;
  abstract refreshInterval: number;

  abstract fetchData(): Promise<WidgetData>;
  abstract formatDisplay(data: WidgetData): string;
}
