#!/usr/bin/env node

import readline from 'node:readline';

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const verbose = args.has('--verbose');
const showBesChunks = verbose || args.has('--show-bes-chunks');
const noColor = args.has('--no-color') || !process.stdout.isTTY;
const timeZone = resolveTimeZone();

const colors = {
  green: '\u001b[32m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  dim: '\u001b[2m',
  reset: '\u001b[0m',
};

function color(value, name) {
  if (noColor) {
    return value;
  }
  return `${colors[name] ?? ''}${value}${colors.reset}`;
}

function resolveTimeZone() {
  if (args.has('--pacific')) {
    return 'America/Los_Angeles';
  }
  if (args.has('--utc')) {
    return 'UTC';
  }

  const timeZoneFlag = rawArgs.find((arg) => arg.startsWith('--timezone='));
  if (timeZoneFlag) {
    const value = timeZoneFlag.slice('--timezone='.length).trim();
    return normalizeTimeZone(value);
  }

  const timeZoneIndex = rawArgs.indexOf('--timezone');
  if (timeZoneIndex !== -1) {
    const value = rawArgs[timeZoneIndex + 1]?.trim();
    return normalizeTimeZone(value);
  }

  return undefined;
}

function normalizeTimeZone(value) {
  if (!value || value === 'system') {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat('en-US', {timeZone: value});
    return value;
  } catch {
    console.error(`Invalid timezone: ${value}`);
    process.exit(1);
  }
}

function compactLabel(direction, layer) {
  if (layer === 'app_lifecycle' && direction === 'phone_app') {
    return color('PHONE APP', 'yellow');
  }
  if (layer === 'app_lifecycle' && direction === 'glasses_app') {
    return color('GLASSES APP', 'yellow');
  }
  if (direction === 'phone_to_glasses') {
    return color('PHONE -> GLASSES', 'green');
  }
  if (direction === 'glasses_to_phone') {
    return color('GLASSES -> PHONE', 'red');
  }
  if (direction === 'phone_to_app') {
    return color('SDK -> APP', 'cyan');
  }
  if (direction === 'phone_to_wifi') {
    return color('PHONE -> WIFI', 'red');
  }
  if (direction === 'wifi_to_phone') {
    return color('WIFI -> PHONE', 'red');
  }
  if (direction === 'glasses_to_wifi') {
    return color('GLASSES -> WIFI', 'red');
  }
  if (direction === 'wifi_to_glasses') {
    return color('WIFI -> GLASSES', 'green');
  }
  if (direction === 'glasses_network') {
    return color('GLASSES NET', 'yellow');
  }
  if (direction === 'asg_to_bes') {
    return color('ASG -> BES', 'red');
  }
  if (direction === 'bes_to_asg') {
    return color('BES -> ASG', 'green');
  }
  if (layer === 'asg_command_router') {
    return color('ASG ROUTER', 'yellow');
  }
  return direction || layer || 'TRACE';
}

function parseLine(line) {
  const traceIndex = line.indexOf('BLE_TRACE ');
  if (traceIndex === -1) {
    return null;
  }

  const prefix = line.slice(0, traceIndex);
  const trace = line.slice(traceIndex + 'BLE_TRACE '.length);
  const payloadMarker = ' payload=';
  const payloadIndex = trace.indexOf(payloadMarker);
  const fieldsText = payloadIndex === -1 ? trace : trace.slice(0, payloadIndex);
  const payloadText = payloadIndex === -1 ? '' : trace.slice(payloadIndex + payloadMarker.length);
  const fields = {};

  for (const match of fieldsText.matchAll(/(\w+)=([^ ]+)/g)) {
    fields[match[1]] = match[2];
  }

  let payload = null;
  try {
    payload = payloadText ? JSON.parse(payloadText) : null;
  } catch {
    payload = payloadText;
  }

  const timeMatch = prefix.match(/\d\d-\d\d\s+(\d\d:\d\d:\d\d\.\d+)/);
  const epochMatch = prefix.match(/^\s*(\d{10})(?:\.(\d{1,9}))?\s/);
  return {
    time: epochMatch ? formatEpoch(epochMatch[1], epochMatch[2]) : (timeMatch?.[1] ?? ''),
    direction: fields.direction ?? '',
    layer: fields.layer ?? '',
    source: fields.source ?? '',
    type: fields.type ?? '',
    bytes: fields.bytes ?? '',
    payload,
  };
}

function formatEpoch(secondsText, fractionText = '') {
  const seconds = Number(secondsText);
  if (!Number.isFinite(seconds)) {
    return '';
  }

  const milliseconds = Number((fractionText.padEnd(3, '0').slice(0, 3)) || 0);
  const date = new Date(seconds * 1000 + milliseconds);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

function flatten(value, prefix = '', output = []) {
  if (value == null) {
    return output;
  }
  if (Array.isArray(value)) {
    output.push([prefix, JSON.stringify(value)]);
    return output;
  }
  if (typeof value !== 'object') {
    output.push([prefix, String(value)]);
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix ? `${prefix}.${key}` : key;
    flatten(child, childKey, output);
  }
  return output;
}

function summarize(trace) {
  if (trace.payload == null || trace.payload === '') {
    return '';
  }
  if (typeof trace.payload === 'string') {
    return trace.payload;
  }

  if (trace.layer === 'app_lifecycle') {
    const priorityKeys = ['event', 'component', 'pid', 'action', 'startId', 'version', 'package'];
    const parts = [];
    for (const key of priorityKeys) {
      if (trace.payload[key] != null) {
        parts.push(`${key}=${trace.payload[key]}`);
      }
    }
    return parts.slice(0, 8).join(' ');
  }

  if (trace.layer === 'bes_trace_log') {
    return trace.payload.line ?? '';
  }

  if (trace.layer === 'bes_trace_control') {
    const parts = [];
    for (const key of ['event', 'reason', 'intervalMs']) {
      if (trace.payload[key] != null) {
        parts.push(`${key}=${trace.payload[key]}`);
      }
    }
    return parts.join(' ');
  }

  if (
    trace.layer === 'wifi_http_output' ||
    trace.layer === 'wifi_http_input' ||
    trace.layer === 'wifi_route'
  ) {
    const priorityKeys = [
      'requestId',
      'route',
      'reason',
      'outcome',
      'statusCode',
      'success',
      'durationMs',
      'fileBytes',
      'imageBytes',
      'jpegBytes',
      'photoBytes',
      'contentLength',
      'remoteHost',
      'remotePort',
      'urlHost',
      'urlPath',
      'method',
      'path',
      'source',
      'wifiConnected',
      'internetValidated',
      'fallback',
      'errorClass',
      'errorMessage',
    ];
    const parts = [];
    for (const key of priorityKeys) {
      if (trace.payload[key] != null) {
        parts.push(`${key}=${singleLine(trace.payload[key])}`);
      }
    }
    return parts.slice(0, 10).join(' ');
  }

  if (
    trace.layer === 'sdk_ble_chunk' ||
    trace.layer === 'sdk_ble_write' ||
    trace.layer === 'asg_ble_outbound_queue'
  ) {
    const priorityKeys = [
      'level',
      'warningReason',
      'stage',
      'requestId',
      'commandType',
      'appId',
      'chunkNumber',
      'totalChunks',
      'chunkIndex',
      'sequence',
      'messageId',
      'durationMs',
      'queueDelayMs',
      'sendDurationMs',
      'maxChunkSendDurationMs',
      'maxChunkSpacingMs',
      'callbackDelayMs',
      'timeSinceLastSendMs',
      'timeSincePreviousChunkSendMs',
      'nextProcessDelayMs',
      'remainingDelayMs',
      'retryDelayMs',
      'pacingDelayMs',
      'writeAccepted',
      'success',
      'complete',
      'status',
      'queueSize',
      'queueSizeAfterAdd',
      'queueSizeAfterPoll',
      'packedBytes',
      'payloadBytes',
      'chunkJsonBytes',
      'messageBytes',
      'wireJsonBytes',
      'reassembledBytes',
      'receivedChunks',
      'currentMtu',
      'writeType',
      'queuedAtMs',
      'wakeup',
      'chunked',
      'cWrapped',
      'chunkId',
      'characteristicUuid',
      'errorClass',
      'errorMessage',
    ];
    const parts = [];
    for (const key of priorityKeys) {
      if (trace.payload[key] != null) {
        parts.push(`${key}=${singleLine(trace.payload[key])}`);
      }
    }
    return parts.slice(0, 16).join(' ');
  }

  if (trace.type === 'k900:sr_log' && trace.payload.B) {
    const body = trace.payload.B.body ?? '';
    return [
      `cur=${trace.payload.B.cur ?? ''}`,
      `chars=${String(body).length}`,
      `terminator=${trace.payload.B.cur === 255}`,
    ].join(' ');
  }

  const omitted = new Set(['type', 'timestamp', 'mId']);
  if (trace.payload.C && trace.type === `k900:${trace.payload.C}`) {
    omitted.add('C');
  }

  const parts = flatten(trace.payload)
    .filter(([key]) => !omitted.has(key))
    .filter(([key]) => !key.startsWith('timestamp.'))
    .slice(0, 8)
    .map(([key, value]) => `${key}=${singleLine(value)}`);

  return parts.join(' ');
}

function singleLine(value) {
  return String(value).replace(/\s*\r?\n\s*/g, '\\n');
}

function formatTrace(trace) {
  const warning =
    trace.payload && typeof trace.payload === 'object' && trace.payload.level === 'warning';
  const left = [
    trace.time.padEnd(12),
    compactLabel(trace.direction, trace.layer).padEnd(noColor ? 18 : 27),
    trace.layer.padEnd(20),
    color(trace.type.padEnd(18), warning ? 'yellow' : 'dim'),
  ].join('  ');

  const summary = summarize(trace);
  const styledSummary = warning ? color(summary, 'yellow') : summary;
  const details =
    verbose && (trace.source || trace.bytes)
      ? color(` source=${trace.source}${trace.bytes ? ` bytes=${trace.bytes}` : ''}`, 'dim')
      : '';

  return `${left}${summary ? `  ${styledSummary}` : ''}${details}`;
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', (line) => {
  const trace = parseLine(line);
  if (!trace) {
    return;
  }
  if (!showBesChunks && (trace.type === 'k900:sr_log' || trace.layer === 'bes_log_stream')) {
    return;
  }
  console.log(formatTrace(trace));
});
