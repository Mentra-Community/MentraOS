import {expect, test} from 'bun:test';
import {compatibleStructuralRoutineLane, compatibleRoutineLane} from './routine-job.service';
import type {PortableRequirements} from '../types/routine-job.types';
import type {RoutingTestHostState} from './test-host-state.service';
import {testFrameworkBinding} from '../testing/framework-fixtures';

const lane = (platform: 'android' | 'ios-on-mac'): RoutingTestHostState['lanes'][number] => ({
  id: 'selected-lane', platform, state: 'idle', dispatchMode: 'automatic',
  resources: [{id: 'selected-app', kind: 'app', capabilities: []}, {id: 'selected-workspace', kind: 'workspace', capabilities: []}],
});
const requirements = (platform: 'android' | 'ios-on-mac', recipient: 'app' | 'worker'): PortableRequirements => ({
  platform, resources: [{kind: recipient === 'app' ? 'app' : 'workspace', capabilities: [],
    permissions: [{permission: recipient === 'app' ? 'camera' : 'accessibility', recipient}]}],
});

test('Mac structural selection can install the exact app before its app permission observation exists', () => {
  const offered = lane('ios-on-mac'), required = requirements('ios-on-mac', 'app');
  expect(compatibleStructuralRoutineLane(required, offered)).toBe(true);
  expect(compatibleRoutineLane(required, offered)).toBe(false);
});
test('Mac structural selection still requires worker permission observations', () => {
  const offered = lane('ios-on-mac'), required = requirements('ios-on-mac', 'worker');
  expect(compatibleStructuralRoutineLane(required, offered)).toBe(false);
  expect(compatibleRoutineLane(required, offered)).toBe(false);
});
test('Android permission selection and execution checks remain unchanged', () => {
  const offered = lane('android'), required = requirements('android', 'app');
  expect(compatibleStructuralRoutineLane(required, offered)).toBe(false);
  expect(compatibleRoutineLane(required, offered)).toBe(false);
});
test('Mac app permission deferral does not admit missing resources or capabilities', () => {
  const required = requirements('ios-on-mac', 'app');
  expect(compatibleStructuralRoutineLane(required, {...lane('ios-on-mac'), resources: []})).toBe(false);
  required.resources[0]!.capabilities = ['required-app-capability'];
  expect(compatibleStructuralRoutineLane(required, lane('ios-on-mac'))).toBe(false);
});
test('Mac execution still requires a fresh granted observation for the exact installed app', () => {
  const now = Date.parse('2026-10-26T00:00:00Z'), binding = testFrameworkBinding();
  const app = {headSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), receiptSha256: 'c'.repeat(64)};
  const offered = lane('ios-on-mac'), required = requirements('ios-on-mac', 'app');
  const observation = {permission: 'camera' as const, status: 'granted' as const, rawStatus: 'authorized', observedAt: new Date(now).toISOString(), binding,
    recipient: {kind: 'app' as const, uid: 501, pid: 50, processStartedAt: 'owned lifetime', launchedAt: now - 1000,
      bundleId: 'com.mentra.mentra' as const, bundlePath: '/Applications/Mentra.app', executablePath: '/Applications/Mentra.app/Mentra',
      version: '3.4.0', build: '1137', teamId: 'T5XXXL6N36', codeRequirement: 'verified signed requirement', selectedBuild: app}, evidence: {sha256: 'd'.repeat(64)}};
  offered.resources[0]!.permissionObservations = [observation];
  expect(compatibleRoutineLane(required, offered, {now, binding, app})).toBe(true);
  for (const status of ['denied', 'unknown', 'unavailable'] as const) {
    offered.resources[0]!.permissionObservations = [{...observation, status}];
    expect(compatibleRoutineLane(required, offered, {now, binding, app})).toBe(false);
  }
  offered.resources[0]!.permissionObservations = [observation];
  expect(compatibleRoutineLane(required, offered, {now: now + 120_001, binding, app})).toBe(false);
  expect(compatibleRoutineLane(required, offered, {now, binding, app: {...app, headSha: 'e'.repeat(40)}})).toBe(false);
});
