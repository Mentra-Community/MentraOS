// src/layout.ts

import { LayoutType, ViewType } from './enums';
import { TpaToCloudMessageType } from './message-types';
import { BaseMessage } from './messages/base';

/**
 * Text wall layout
 */
export interface TextWall {
    layoutType: LayoutType.TEXT_WALL;
    text: string;
}

/**
 * Double text wall layout
 */
export interface DoubleTextWall {
    layoutType: LayoutType.DOUBLE_TEXT_WALL;
    topText: string;
    bottomText: string;
}

/**
 * Dashboard card layout
 */
export interface DashboardCard {
    layoutType: LayoutType.DASHBOARD_CARD;
    leftText: string;
    rightText: string;
}

/**
 * Reference card layout
 */
export interface ReferenceCard {
    layoutType: LayoutType.REFERENCE_CARD;
    title: string;
    text: string;
}

export interface BitmapView {
    layoutType: LayoutType.BITMAP_VIEW;
    data: string;
}

/**
 * Union type for all layouts
 */
export type Layout = TextWall | DoubleTextWall | DashboardCard | ReferenceCard | BitmapView;

export interface DisplayRequest extends BaseMessage {
    type: TpaToCloudMessageType.DISPLAY_REQUEST;
    packageName: string;
    view: ViewType;
    layout: Layout;
    durationMs?: number;
    forceDisplay?: boolean;
}