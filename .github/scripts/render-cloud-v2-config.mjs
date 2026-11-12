#!/usr/bin/env bun
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {CLOUD_V2_TARGETS} from './coordinated-cloud-v2-records.mjs'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function keys(value, allowed, label) {
  object(value, label)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`)
  }
}

function rejectEnvironmentFields(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['env', 'envGroups', 'domains'].includes(key)) {
      throw new Error(`Shared deployment source cannot contain ${key}; use the guarded target table or Doppler`)
    }
    rejectEnvironmentFields(child)
  }
}

export function renderCloudV2Config(sourceRoot, environment) {
  if (!Object.hasOwn(CLOUD_V2_TARGETS, environment)) {
    throw new Error(`Unsupported Cloud V2 environment ${JSON.stringify(environment)}`)
  }
  const target = CLOUD_V2_TARGETS[environment]
  const read = filename => {
    try {
      return Bun.YAML.parse(readFileSync(path.join(sourceRoot, 'cloud-v2/deploy', filename), 'utf8'))
    } catch (error) {
      throw new Error(`Frozen release source requires cloud-v2/deploy/${filename}: ${error.message}`)
    }
  }
  const base = read('porter.shared.yaml')
  keys(base, ['version', 'build', 'services'], 'Shared Porter configuration')
  rejectEnvironmentFields(base)
  if (base.version !== 'v2' || !Array.isArray(base.services)) throw new Error('Expected Porter v2 services')
  keys(base.build, ['method', 'context', 'dockerfile'], 'Shared build')
  if (base.build.method !== 'docker' || base.build.context !== '../' || base.build.dockerfile !== './docker/Dockerfile') {
    throw new Error('Shared build must use the repository Dockerfile from the cloud-v2 directory')
  }
  const names = base.services.map(service => {
    keys(service, ['name', 'type', 'run', 'port', 'instances', 'cpuCores', 'ramMegabytes',
      'livenessCheck', 'readinessCheck', 'ingressAnnotations', 'terminationGracePeriodSeconds', 'additionalPorts'], 'Shared service')
    return service.name
  })
  if (names.length !== 2 || new Set(names).size !== 2 || !names.includes('core') || !names.includes('runtime')) {
    throw new Error('Shared configuration requires exactly one core and one runtime service')
  }
  for (const service of base.services) {
    if (!Number.isSafeInteger(service.instances) || service.instances < 1) {
      throw new Error(`${service.name} requires a positive replica count`)
    }
    if (service.type !== 'web' || typeof service.run !== 'string' || !service.run.trim() ||
        !Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535 ||
        !(service.cpuCores > 0) || !(service.ramMegabytes > 0)) {
      throw new Error(`${service.name} requires a web entrypoint, valid port and positive resources`)
    }
    for (const [name, httpPath] of [['livenessCheck', '/healthz'], ['readinessCheck', '/ready']]) {
      const probe = service[name]
      if (probe?.enabled !== true || probe.httpPath !== httpPath || !(probe.timeoutSeconds > 0) ||
          !Number.isSafeInteger(probe.initialDelaySeconds) || probe.initialDelaySeconds < 0) {
        throw new Error(`${service.name} requires an enabled ${name} at ${httpPath}`)
      }
    }
  }
  if (!/^cloud-v2-[a-z0-9-]*doppler[a-z0-9-]*$/.test(target.porterEnvironmentGroup)) {
    throw new Error('Target requires its linked Doppler environment group')
  }
  const config = {
    version: base.version,
    name: target.porterApp,
    envGroups: [target.porterEnvironmentGroup],
    build: base.build,
    services: base.services.map(service => {
      const hosts = target.services[service.name]
      if (!hosts?.length || hosts.some(host => !/^[a-z0-9.-]+$/.test(host))) {
        throw new Error(`Target requires valid ${service.name} domains`)
      }
      return {...service, domains: hosts.map(name => ({name}))}
    }),
  }
  const policy = read('runtime-policy.yaml')
  keys(policy, ['core', 'runtime'], 'Shared service policy')
  for (const service of ['core', 'runtime']) {
    const label = service === 'core' ? 'Core' : 'Runtime'
    keys(policy[service], ['podDisruptionBudget', 'deploymentStrategy'], `${label} policy`)
    keys(policy[service].podDisruptionBudget, ['enabled', 'minAvailablePercentage'], `${label} disruption budget`)
    keys(policy[service].deploymentStrategy, ['kind', 'rolling'], `${label} deployment strategy`)
    keys(policy[service].deploymentStrategy.rolling, ['maxUnavailable', 'maxSurge'], `${label} rolling strategy`)
    const {podDisruptionBudget: budget, deploymentStrategy: strategy} = policy[service]
    if (budget.enabled !== true || budget.minAvailablePercentage !== 100 || strategy.kind !== 'rolling' ||
        strategy.rolling.maxUnavailable !== 0 || strategy.rolling.maxSurge !== 1) {
      throw new Error(`${label} requires PDB100 and rolling maxUnavailable0/maxSurge1 in every environment`)
    }
  }
  return {
    config,
    overrides: {[`${target.porterApp}-core`]: policy.core, [`${target.porterApp}-runtime`]: policy.runtime},
    configPath: target.porterConfig,
    overridesPath: target.porterConfig.replace(/\.yaml$/, '.overrides.yaml'),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--source-root' || args[2] !== '--environment') {
    throw new Error('Usage: bun render-cloud-v2-config.mjs --source-root ROOT --environment dev|staging|prod')
  }
  const root = path.resolve(args[1])
  const rendered = renderCloudV2Config(root, args[3])
  const sha256 = text => createHash('sha256').update(text).digest('hex')
  const receipt = {environment: args[3], sourceCommit: process.env.SOURCE_COMMIT || null,
    runtimeReplicas: rendered.config.services.find(service => service.name === 'runtime').instances, files: []}
  for (const [filename, value] of [[rendered.configPath, rendered.config], [rendered.overridesPath, rendered.overrides]]) {
    const text = `${Bun.YAML.stringify(value, null, 2)}\n`
    writeFileSync(path.join(root, filename), text)
    receipt.files.push({path: filename, sha256: sha256(text)})
  }
  console.log(JSON.stringify(receipt, null, 2))
}
