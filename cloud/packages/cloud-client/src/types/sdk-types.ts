/**
 * Re-exported types from the AugmentOS SDK for external use
 * This allows the client to expose necessary types without requiring
 * consumers to install the full SDK package
 */

// Message types from glasses to cloud
export type GlassesToCloudMessageType =
  | "connection_init"
  | "start_app"
  | "stop_app"
  | "vad"
  | "head_position"
  | "location_update"
  | "button_press"
  | "core_status_update"
  | "glasses_connection_state"
  | "request_settings";

// Message types from cloud to glasses
export type CloudToGlassesMessageType =
  | "connection_ack"
  | "connection_error"
  | "display_event"
  | "app_state_change"
  | "microphone_state_change"
  | "settings_update"
  | "livekit_info";

// Layout types
export enum LayoutType {
  TEXT_WALL = "text_wall",
  DOUBLE_TEXT_WALL = "double_text_wall",
  DASHBOARD_CARD = "dashboard_card",
  REFERENCE_CARD = "reference_card",
  BITMAP_VIEW = "bitmap_view",
  CLEAR_VIEW = "clear_view",
}

export enum ViewType {
  MAIN = "main",
  DASHBOARD = "dashboard",
}

// Layout interfaces
export interface TextWall {
  layoutType: LayoutType.TEXT_WALL;
  text: string;
}

export interface DoubleTextWall {
  layoutType: LayoutType.DOUBLE_TEXT_WALL;
  topText: string;
  bottomText: string;
}

export interface DashboardCard {
  layoutType: LayoutType.DASHBOARD_CARD;
  leftText: string;
  rightText: string;
}

export interface ReferenceCard {
  layoutType: LayoutType.REFERENCE_CARD;
  title: string;
  text: string;
}

export interface BitmapView {
  layoutType: LayoutType.BITMAP_VIEW;
  data: string;
}

export interface ClearView {
  layoutType: LayoutType.CLEAR_VIEW;
}

export type Layout =
  | TextWall
  | DoubleTextWall
  | DashboardCard
  | ReferenceCard
  | BitmapView
  | ClearView;

// Base message interface
export interface BaseMessage {
  timestamp: Date;
}

// Key message interfaces we'll need
export interface GlassesToCloudMessage extends BaseMessage {
  type: GlassesToCloudMessageType;
}

export interface CloudToGlassesMessage extends BaseMessage {
  type: CloudToGlassesMessageType;
}

export interface DisplayRequest {
  type: "display_event";
  packageName: string;
  view: ViewType;
  layout: Layout;
  durationMs?: number;
  forceDisplay?: boolean;
}
