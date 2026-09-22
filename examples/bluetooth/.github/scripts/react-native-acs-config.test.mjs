import assert from 'node:assert/strict'
import {copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function fixture(t, dependencies) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-acs-config-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const engine = path.join(root, 'node_modules/@mentra/engine')
  mkdirSync(engine, {recursive: true})
  writeFileSync(path.join(engine, 'package.json'), JSON.stringify({name: '@mentra/engine', dependencies}))
  const configPath = path.join(root, 'app.config.js')
  copyFileSync(new URL('../../examples/react-native/app.config.js', import.meta.url), configPath)
  return {engine, configure: createRequire(configPath)(configPath)}
}

test('older Engine releases preserve the host configuration without requiring ACS', (t) => {
  const {configure} = fixture(t, {})
  const config = {name: 'Example', plugins: ['expo-audio'], extra: {releaseIdentity: '3.2.0-dev.116'}}
  assert.equal(configure({config}), config)
})

test('ACS uses the exact Engine dependency even when it is not hoisted', (t) => {
  const {engine, configure} = fixture(t, {'@mentra/acs-meeting': '3.2.0-dev.136'})
  const acs = path.join(engine, 'node_modules/@mentra/acs-meeting')
  mkdirSync(acs, {recursive: true})
  const plugin = path.join(acs, 'app.plugin.js')
  writeFileSync(plugin, 'module.exports = config => config\n')
  const config = {name: 'Example', plugins: ['expo-audio'], extra: {releaseIdentity: '3.2.0-dev.136'}}
  assert.deepEqual(configure({config}), {...config, plugins: ['expo-audio', realpathSync(plugin)]})
  assert.deepEqual(config.plugins, ['expo-audio'])
})

test('an Engine release declaring ACS fails clearly if its plugin is missing', (t) => {
  const {configure} = fixture(t, {'@mentra/acs-meeting': '3.2.0-dev.136'})
  assert.throws(() => configure({config: {plugins: []}}), /@mentra\/acs-meeting\/app.plugin.js/)
})

for (const withAcs of [false, true]) {
  test(`bundle identifier override preserves host configuration with ACS=${withAcs}`, (t) => {
    const previous = process.env.MENTRA_IOS_BUNDLE_ID
    t.after(() => {
      if (previous === undefined) delete process.env.MENTRA_IOS_BUNDLE_ID
      else process.env.MENTRA_IOS_BUNDLE_ID = previous
    })
    const {engine, configure} = fixture(t, withAcs ? {'@mentra/acs-meeting': '3.2.0-dev.136'} : {})
    let plugin
    if (withAcs) {
      const acs = path.join(engine, 'node_modules/@mentra/acs-meeting')
      mkdirSync(acs, {recursive: true})
      plugin = path.join(acs, 'app.plugin.js')
      writeFileSync(plugin, 'module.exports = config => config\n')
    }
    const config = {
      ios: {bundleIdentifier: 'com.mentra.example', entitlements: {'com.apple.developer.networking.wifi-info': true}},
      android: {package: 'com.mentra.example'},
      plugins: ['expo-audio'],
    }
    for (const value of ['', '   ', ' com.yourname.mentrasdkrn ']) {
      process.env.MENTRA_IOS_BUNDLE_ID = value
      assert.deepEqual(configure({config}), {
        ...config,
        ios: {...config.ios, bundleIdentifier: value.trim() || config.ios.bundleIdentifier},
        plugins: withAcs ? [...config.plugins, realpathSync(plugin)] : config.plugins,
      })
      assert.equal(config.ios.bundleIdentifier, 'com.mentra.example')
      assert.deepEqual(config.plugins, ['expo-audio'])
    }
  })
}
