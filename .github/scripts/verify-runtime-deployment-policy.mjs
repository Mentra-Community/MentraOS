#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {CLOUD_V2_TARGETS} from './coordinated-cloud-v2-records.mjs'

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function selectorLabels(selector, label) {
  const labels = selector?.matchLabels
  requireValue(labels && typeof labels === 'object' && !Array.isArray(labels) &&
    Object.keys(labels).length > 0 && Object.values(labels).every(value => typeof value === 'string'),
  `${label} requires nonempty matchLabels`)
  requireValue(!selector.matchExpressions?.length, `${label} must use the generated matchLabels selector`)
  return labels
}

function sameLabels(left, right) {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => right[key] === value)
}

export function verifyRuntimeDeploymentPolicy({environment, expectedReplicas, observations, observedAt = new Date().toISOString()}) {
  requireValue(Object.hasOwn(CLOUD_V2_TARGETS, environment), 'Unsupported Cloud V2 environment')
  requireValue(Number.isSafeInteger(expectedReplicas) && expectedReplicas > 0, 'Expected Runtime replicas must be a positive integer')
  requireValue(observations?.kind === 'List' && Array.isArray(observations.items), 'Expected a combined Kubernetes List')
  requireValue(typeof observedAt === 'string' && new Date(observedAt).toISOString() === observedAt, 'observedAt must be an ISO UTC timestamp')
  const app = CLOUD_V2_TARGETS[environment].porterApp
  const name = `${app}-runtime`
  const selected = kind => {
    const matches = observations.items.filter(item => item.kind === kind &&
      item.metadata?.labels?.['porter.run/app-name'] === app &&
      item.metadata?.labels?.['porter.run/service-name'] === 'runtime')
    requireValue(matches.length === 1, `Expected exactly one ${app} Runtime ${kind}`)
    const item = matches[0]
    requireValue(item.metadata.name === name && typeof item.metadata.uid === 'string' && item.metadata.uid.length > 0 &&
      typeof item.metadata.namespace === 'string' && item.metadata.namespace.length > 0 &&
      Number.isSafeInteger(item.metadata.generation) && item.metadata.generation > 0 && !item.metadata.deletionTimestamp,
    `Invalid current ${kind} identity`)
    requireValue(item.status?.observedGeneration === item.metadata.generation, `${kind} observation is stale`)
    return item
  }
  const deployment = selected('Deployment')
  const budget = selected('PodDisruptionBudget')
  requireValue(deployment.metadata.namespace === budget.metadata.namespace, 'Runtime Deployment and PDB namespaces differ')
  requireValue(deployment.spec?.replicas === expectedReplicas, 'Runtime spec replicas differ from generated configuration')
  for (const key of ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas']) {
    requireValue(deployment.status[key] === expectedReplicas, `Runtime ${key} is not fully settled and ready`)
  }
  requireValue((deployment.status.terminatingReplicas ?? 0) === 0, 'Runtime still has terminating replicas')
  const strategy = deployment.spec.strategy
  requireValue(strategy?.type === 'RollingUpdate' && strategy.rollingUpdate?.maxUnavailable === 0 &&
    strategy.rollingUpdate?.maxSurge === 1, 'Runtime requires rolling maxUnavailable0/maxSurge1')
  const deploymentLabels = selectorLabels(deployment.spec.selector, 'Runtime Deployment')
  const budgetLabels = selectorLabels(budget.spec?.selector, 'Runtime PDB')
  requireValue(sameLabels(deploymentLabels, budgetLabels), 'Runtime PDB selector differs from Deployment selector')
  requireValue(deploymentLabels['app.kubernetes.io/instance'] === app &&
    deploymentLabels['app.kubernetes.io/name'] === name, 'Runtime selector does not identify the guarded target')
  const templateLabels = deployment.spec.template?.metadata?.labels
  requireValue(templateLabels && Object.entries(deploymentLabels).every(([key, value]) => templateLabels[key] === value),
    'Runtime selector does not match its pod template')
  requireValue(budget.spec.minAvailable === '100%' && budget.spec.maxUnavailable === undefined, 'Runtime requires PDB minAvailable100%')
  for (const key of ['desiredHealthy', 'currentHealthy', 'expectedPods']) {
    requireValue(budget.status[key] === expectedReplicas, `Runtime PDB ${key} differs from generated replicas`)
  }
  requireValue(budget.status.disruptionsAllowed === 0, 'Runtime PDB permits disruption of a required replica')
  return {
    observedAt, environment, app, namespace: deployment.metadata.namespace, replicas: expectedReplicas,
    deployment: {name, uid: deployment.metadata.uid, generation: deployment.metadata.generation,
      observedGeneration: deployment.status.observedGeneration, readyReplicas: deployment.status.readyReplicas,
      rolling: {maxUnavailable: 0, maxSurge: 1}},
    budget: {name, uid: budget.metadata.uid, generation: budget.metadata.generation,
      observedGeneration: budget.status.observedGeneration, minAvailable: '100%',
      desiredHealthy: budget.status.desiredHealthy, currentHealthy: budget.status.currentHealthy, disruptionsAllowed: 0},
    selector: deploymentLabels,
  }
}

function main() {
  const args = process.argv.slice(2)
  const allowed = ['--environment', '--replicas', '--observations', '--output']
  const parsed = {}
  requireValue(args.length === allowed.length * 2, 'Usage: verify-runtime-deployment-policy.mjs --environment dev|staging|prod --replicas N --observations LIST.json --output RECEIPT.json')
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    requireValue(allowed.includes(key) && !Object.hasOwn(parsed, key) && args[index + 1], 'Invalid or duplicate CLI argument')
    parsed[key] = args[index + 1]
  }
  requireValue(/^[1-9][0-9]*$/.test(parsed['--replicas']), 'Expected Runtime replicas must be a positive integer')
  const receipt = verifyRuntimeDeploymentPolicy({environment: parsed['--environment'],
    expectedReplicas: Number(parsed['--replicas']), observations: JSON.parse(readFileSync(path.resolve(parsed['--observations']), 'utf8'))})
  writeFileSync(path.resolve(parsed['--output']), `${JSON.stringify(receipt, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
