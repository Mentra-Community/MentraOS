import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'
import {verifyRuntimeDeploymentPolicy} from './verify-runtime-deployment-policy.mjs'

const observedAt = '2026-10-15T00:30:00.000Z'
function fixture(environment = 'dev', replicas = 1) {
  const app = `cloud-${environment}`
  const name = `${app}-runtime`
  const labels = {'app.kubernetes.io/instance': app, 'app.kubernetes.io/name': name}
  const metadata = uid => ({name, namespace: 'default', uid, generation: 4,
    labels: {'porter.run/app-name': app, 'porter.run/service-name': 'runtime'}})
  return {kind: 'List', items: [
    {kind: 'Deployment', metadata: metadata('deployment-uid'), spec: {replicas,
      strategy: {type: 'RollingUpdate', rollingUpdate: {maxUnavailable: 0, maxSurge: 1}},
      selector: {matchLabels: {...labels}}, template: {metadata: {labels: {...labels}}}},
    status: {observedGeneration: 4, replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas}},
    {kind: 'PodDisruptionBudget', metadata: metadata('budget-uid'),
      spec: {minAvailable: '100%', selector: {matchLabels: {...labels}}},
      status: {observedGeneration: 4, desiredHealthy: replicas, currentHealthy: replicas, expectedPods: replicas, disruptionsAllowed: 0}},
  ]}
}
const verify = observations => verifyRuntimeDeploymentPolicy({environment: 'dev', expectedReplicas: 1, observations, observedAt})

test('verifies generated replica count and exact policy for each guarded environment', () => {
  for (const environment of ['dev', 'staging', 'prod']) {
    const result = verifyRuntimeDeploymentPolicy({environment, expectedReplicas: 2, observations: fixture(environment, 2), observedAt})
    assert.equal(result.app, `cloud-${environment}`)
    assert.equal(result.replicas, 2)
    assert.equal(result.deployment.uid, 'deployment-uid')
    assert.equal(result.budget.disruptionsAllowed, 0)
    assert.equal(result.observedAt, observedAt)
  }
})

test('ignores Core and another environment but refuses missing or duplicate Runtime policy objects', () => {
  const observation = fixture()
  observation.items.push({...observation.items[0], metadata: {...observation.items[0].metadata,
    name: 'cloud-dev-core', labels: {'porter.run/app-name': 'cloud-dev', 'porter.run/service-name': 'core'}}})
  observation.items.push(...fixture('staging').items)
  assert.equal(verify(observation).app, 'cloud-dev')
  const missing = fixture(); missing.items.pop()
  assert.throws(() => verify(missing), /exactly one.*PodDisruptionBudget/)
  const duplicate = fixture(); duplicate.items.push(structuredClone(duplicate.items[0]))
  assert.throws(() => verify(duplicate), /exactly one.*Deployment/)
})

test('refuses stale generation, wrong replica counts and unfinished rollout', () => {
  for (const mutate of [
    data => {data.items[0].status.observedGeneration = 3},
    data => {data.items[1].status.observedGeneration = 3},
    data => {data.items[0].spec.replicas = 2},
    data => {data.items[0].status.readyReplicas = 0},
    data => {delete data.items[0].status.readyReplicas},
    data => {data.items[0].status.updatedReplicas = 0},
    data => {data.items[0].status.availableReplicas = 0},
    data => {data.items[0].status.terminatingReplicas = 1},
    data => {data.items[0].metadata.deletionTimestamp = observedAt},
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => verify(data))
  }
})

test('refuses mismatched, empty, broad or non-template selectors', () => {
  for (const mutate of [
    data => {data.items[1].spec.selector.matchLabels.extra = 'other'},
    data => {data.items[1].spec.selector.matchLabels = {}},
    data => {data.items[0].spec.selector.matchExpressions = [{key: 'other', operator: 'Exists'}]},
    data => {delete data.items[0].spec.template.metadata.labels['app.kubernetes.io/name']},
    data => {data.items[1].metadata.namespace = 'other'},
    data => {data.items[0].metadata.name = 'other'},
    data => {delete data.items[0].metadata.uid},
    data => {for (const item of data.items) item.spec.selector.matchLabels = {shared: 'all'}},
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => verify(data))
  }
})

test('refuses weaker budget, stale health and unsafe rolling strategy', () => {
  for (const mutate of [
    data => {data.items[1].spec.minAvailable = '50%'},
    data => {data.items[1].spec.maxUnavailable = 0},
    data => {data.items[1].status.currentHealthy = 0},
    data => {data.items[1].status.desiredHealthy = 0},
    data => {data.items[1].status.expectedPods = 2},
    data => {data.items[1].status.disruptionsAllowed = 1},
    data => {data.items[0].spec.strategy.rollingUpdate.maxUnavailable = '0%'},
    data => {data.items[0].spec.strategy.rollingUpdate.maxSurge = 0},
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => verify(data))
  }
})

test('refuses unsupported environment, count or input shape', () => {
  for (const expectedReplicas of [0, -1, 1.5, NaN]) {
    assert.throws(() => verifyRuntimeDeploymentPolicy({environment: 'dev', expectedReplicas, observations: fixture()}))
  }
  assert.throws(() => verifyRuntimeDeploymentPolicy({environment: 'debug', expectedReplicas: 1, observations: fixture()}))
  assert.throws(() => verify({items: fixture().items}), /Kubernetes List/)
})

test('CLI writes proof only after successful observation and refuses unknown arguments', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'runtime-policy-'))
  try {
    const input = path.join(directory, 'objects.json'), output = path.join(directory, 'proof.json')
    writeFileSync(input, JSON.stringify(fixture()))
    const args = ['--environment', 'dev', '--replicas', '1', '--observations', input, '--output', output]
    const script = new URL('./verify-runtime-deployment-policy.mjs', import.meta.url)
    assert.equal(spawnSync(process.execPath, [script.pathname, ...args]).status, 0)
    assert.equal(JSON.parse(readFileSync(output)).budget.uid, 'budget-uid')
    rmSync(output)
    const invalid = fixture(); invalid.items.pop(); writeFileSync(input, JSON.stringify(invalid))
    assert.notEqual(spawnSync(process.execPath, [script.pathname, ...args]).status, 0)
    assert.equal(existsSync(output), false)
    assert.notEqual(spawnSync(process.execPath, [script.pathname, ...args.slice(0, -2), '--unknown', output]).status, 0)
  } finally {rmSync(directory, {recursive: true, force: true})}
})
