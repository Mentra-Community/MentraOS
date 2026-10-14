import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('dev Runtime keeps its singleton capacity and readiness', () => {
  const config = source('../../cloud-v2/porter.dev.yaml')
  const runtime = config.slice(config.indexOf('  - name: runtime\n'))
  assert.match(runtime, /instances: 1/)
  assert.match(runtime, /cpuCores: 0\.5\n    ramMegabytes: 2048/)
  assert.match(runtime, /readinessCheck:\n      enabled: true\n      httpPath: \/ready/)
  assert.match(runtime, /terminationGracePeriodSeconds: 10/)
})

test('Runtime blocks last-ready voluntary eviction without placement expansion', () => {
  const overrides = source('../../cloud-v2/porter.dev.overrides.yaml')
  assert.match(overrides, /^cloud-dev-runtime:/m)
  assert.doesNotMatch(overrides, /^cloud-dev-core:/m)
  assert.match(overrides, /podDisruptionBudget:\n    enabled: true\n    minAvailablePercentage: 100/)
  assert.match(overrides, /maxUnavailable: 0\n      maxSurge: 1/)
  assert.doesNotMatch(overrides, /affinity|nodeGroups|replicaCount|do-not-disrupt/)
})

test('normal dev source deployment carries its required Helm override', () => {
  const workflow = source('../workflows/reusable-coordinated-cloud-v2.yml')
  assert.match(workflow, /overrides="\$\{config%\.yaml\}\.overrides\.yaml"/)
  assert.match(workflow, /if \[\[ "\$PORTER_APP_NAME" == "cloud-dev" \]\]; then\n\s+\[\[ -s "\$overrides" \]\]/)
  assert.match(workflow, /helm_args=\(--helm-overrides-file "\$overrides"\)/)
  assert.match(workflow, /-f "\$config" \\\n\s+"\$\{helm_args\[@\]\}" \\/)
  assert.match(workflow, /cancel-in-progress: false/)
})
