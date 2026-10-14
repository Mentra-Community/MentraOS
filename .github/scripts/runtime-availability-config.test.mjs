import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('dev Runtime requests redundant serving capacity with unchanged health and drain', () => {
  const config = source('../../cloud-v2/porter.dev.yaml')
  const at = config.indexOf('  - name: runtime\n')
  const core = config.slice(0, at)
  const runtime = config.slice(at)
  assert.match(core, /instances: 1/)
  assert.match(runtime, /instances: 2/)
  assert.match(runtime, /readinessCheck:\n      enabled: true\n      httpPath: \/ready/)
  assert.match(runtime, /terminationGracePeriodSeconds: 10/)
})

test('Runtime override guards voluntary disruption and node placement', () => {
  const overrides = source('../../cloud-v2/porter.dev.overrides.yaml')
  assert.match(overrides, /^cloud-dev-runtime:/m)
  assert.doesNotMatch(overrides, /^cloud-dev-core:/m)
  assert.match(overrides, /podDisruptionBudget:\n    enabled: true\n    minAvailablePercentage: 50/)
  assert.match(overrides, /maxUnavailable: 0\n      maxSurge: 1/)
  assert.match(overrides, /requiredDuringSchedulingIgnoredDuringExecution:/)
  assert.match(overrides, /app\.kubernetes\.io\/instance: cloud-dev/)
  assert.match(overrides, /app\.kubernetes\.io\/name: cloud-dev-runtime/)
  assert.match(overrides, /topologyKey: kubernetes\.io\/hostname/)
})

test('normal dev source deployment requires the matching Helm overrides', () => {
  const workflow = source('../workflows/reusable-coordinated-cloud-v2.yml')
  assert.match(workflow, /overrides="\$\{config%\.yaml\}\.overrides\.yaml"/)
  assert.match(workflow, /if \[\[ "\$PORTER_APP_NAME" == "cloud-dev" \]\]; then\n\s+\[\[ -s "\$overrides" \]\]/)
  assert.match(workflow, /helm_args=\(--helm-overrides-file "\$overrides"\)/)
  assert.match(workflow, /-f "\$config" \\\n\s+"\$\{helm_args\[@\]\}" \\/)
  assert.match(workflow, /cancel-in-progress: false/)
})
