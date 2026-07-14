import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const sourceRoot = 'asg_client/app/src/main/java';
const resetterPath = join(
  sourceRoot,
  'com/mentra/asg_client/version/AsgDowngradeResetter.java',
);
const expectedCustomStores = new Set([
  'MentraOSNetworkManager',
  'RecoveryWorkerManagerPrefs',
  'asg_settings',
  'boot_stats',
  'ota_session',
  'ota_state',
]);

function javaFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? javaFiles(path) : path.endsWith('.java') ? [path] : [];
  });
}

function preferenceStoresIn(path) {
  const source = readFileSync(path, 'utf8');
  const constants = new Map();
  for (const match of source.matchAll(/static\s+final\s+String\s+(\w+)\s*=\s*"([^"]+)"/g)) {
    constants.set(match[1], match[2]);
  }

  const stores = [];
  for (const match of source.matchAll(/getSharedPreferences\s*\(\s*("[^"]+"|\w+)\s*,/g)) {
    const expression = match[1];
    const value = expression.startsWith('"')
      ? expression.slice(1, -1)
      : constants.get(expression);
    assert.ok(value, `Cannot statically resolve preference store ${expression} in ${path}`);
    stores.push(value);
  }
  return stores;
}

test('every ASG SharedPreferences store is owned by the downgrade reset contract', () => {
  const discovered = new Set();
  let usesDefaultPreferences = false;
  for (const path of javaFiles(sourceRoot)) {
    if (path === resetterPath) continue;
    const source = readFileSync(path, 'utf8');
    if (source.includes('PreferenceManager.getDefaultSharedPreferences(')) {
      usesDefaultPreferences = true;
    }
    for (const store of preferenceStoresIn(path)) discovered.add(store);
  }

  assert.deepEqual([...discovered].sort(), [...expectedCustomStores].sort());
  assert.equal(usesDefaultPreferences, true);

  const resetter = readFileSync(resetterPath, 'utf8');
  for (const store of expectedCustomStores) {
    assert.ok(resetter.includes(`"${store}"`), `Downgrade reset omits ${store}`);
  }
  assert.ok(
    resetter.includes('"com.mentra.asg_client_preferences"'),
    'Downgrade reset omits Android default SharedPreferences',
  );
});

test('bundled recovery worker version advances with the downgrade handoff contract', () => {
  const recoveryBuild = readFileSync('asg_client/recovery_worker/app/build.gradle', 'utf8');
  const recoveryManager = readFileSync(
    join(sourceRoot, 'com/mentra/asg_client/RecoveryWorkerManager.java'),
    'utf8',
  );
  const buildVersion = Number(recoveryBuild.match(/\bversionCode\s+(\d+)/)?.[1]);
  const assetVersion = Number(
    recoveryManager.match(/ASSETS_RECOVERY_VERSION\s*=\s*(\d+)/)?.[1],
  );

  assert.ok(buildVersion >= 7, 'recovery worker handoff receiver requires versionCode 7+');
  assert.equal(assetVersion, buildVersion, 'bundled recovery fallback version must match the APK');
});

test('ASG and recovery worker share the complete install transaction action contract', () => {
  const asgConstants = readFileSync(
    join(sourceRoot, 'com/mentra/asg_client/io/ota/utils/OtaConstants.java'),
    'utf8',
  );
  const recoveryConstants = readFileSync(
    'asg_client/recovery_worker/app/src/main/java/com/mentra/recovery/util/RecoveryConstants.java',
    'utf8',
  );
  const recoveryManifest = readFileSync(
    'asg_client/recovery_worker/app/src/main/AndroidManifest.xml',
    'utf8',
  );
  for (const action of [
    'com.mentra.recovery.ACTION_ASG_INSTALL_PENDING',
    'com.mentra.recovery.ACTION_ASG_INSTALL_READY',
    'com.mentra.recovery.ACTION_ASG_INSTALL_CANCEL',
  ]) {
    assert.ok(asgConstants.includes(action), `ASG is missing recovery action ${action}`);
    assert.ok(recoveryConstants.includes(action), `recovery is missing action ${action}`);
    assert.ok(recoveryManifest.includes(action), `manifest is missing recovery action ${action}`);
  }
});
