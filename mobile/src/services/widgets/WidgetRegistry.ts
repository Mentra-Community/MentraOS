import { Widget } from './Widget';

/**
 * Registry to manage all dashboard widgets
 */
export class WidgetRegistry {
  private static instance: WidgetRegistry;
  private widgets: Map<string, Widget> = new Map();
  private widgetOrder: string[] = [];

  private constructor() {}

  static getInstance(): WidgetRegistry {
    if (!WidgetRegistry.instance) {
      WidgetRegistry.instance = new WidgetRegistry();
    }
    return WidgetRegistry.instance;
  }

  register(widget: Widget): void {
    this.widgets.set(widget.id, widget);
    if (!this.widgetOrder.includes(widget.id)) {
      this.widgetOrder.push(widget.id);
    }
  }

  unregister(widgetId: string): void {
    this.widgets.delete(widgetId);
    this.widgetOrder = this.widgetOrder.filter(id => id !== widgetId);
  }

  getWidget(widgetId: string): Widget | undefined {
    return this.widgets.get(widgetId);
  }

  getAllWidgets(): Widget[] {
    return this.widgetOrder
      .map(id => this.widgets.get(id))
      .filter((w): w is Widget => w !== undefined);
  }

  getEnabledWidgets(): Widget[] {
    return this.getAllWidgets().filter(w => w.enabled);
  }

  setWidgetEnabled(widgetId: string, enabled: boolean): void {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      widget.enabled = enabled;
    }
  }

  setWidgetOrder(order: string[]): void {
    this.widgetOrder = order.filter(id => this.widgets.has(id));
  }

  getWidgetOrder(): string[] {
    return [...this.widgetOrder];
  }
}
