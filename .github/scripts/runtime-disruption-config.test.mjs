import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {CLOUD_V2_TARGETS, createCloudV2DeploymentRecord, validateCloudV2DeploymentRecord} from './coordinated-cloud-v2-records.mjs'
import {sourceProblems} from './porter-doppler-source.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const renderer = path.join(root, '.github/scripts/render-cloud-v2-config.mjs')
const source = filename => readFileSync(path.join(root, filename), 'utf8')
const bun = args => {
  const result = spawnSync(process.env.BUN_BIN || 'bun', args, {encoding: 'utf8'})
  if (result.error) throw result.error
  return result
}
const parse = filename => {
  const result = bun(['-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))', filename])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloud-v2-policy-'))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  mkdirSync(path.join(directory, 'cloud-v2/deploy'), {recursive: true})
  for (const name of ['porter.shared.yaml', 'runtime-policy.yaml']) {
    writeFileSync(path.join(directory, 'cloud-v2/deploy', name), source(`cloud-v2/deploy/${name}`))
  }
  return directory
}

test('all promoted environments render identical behavior and scoped Core and Runtime protection', t => {
  const directory = fixture(t)
  const configurations = []
  for (const [environment, target] of Object.entries(CLOUD_V2_TARGETS)) {
    const result = bun([renderer, '--source-root', directory, '--environment', environment])
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.environment, environment)
    assert.equal(receipt.runtimeReplicas, 1)
    assert.equal(receipt.files[0].path, target.porterConfig)
    assert.match(receipt.files[0].sha256, /^[a-f0-9]{64}$/)
    const configPath = path.join(directory, target.porterConfig)
    const config = parse(configPath)
    assert.equal(config.name, target.porterApp)
    assert.deepEqual(config.envGroups, [target.porterEnvironmentGroup])
    assert.deepEqual(sourceProblems(configPath, readFileSync(configPath, 'utf8')), [])
    for (const service of config.services) {
      assert.deepEqual(service.domains, target.services[service.name].map(name => ({name})))
      delete service.domains
    }
    delete config.name
    delete config.envGroups
    configurations.push(config)
    const overrides = parse(path.join(directory, target.porterConfig.replace(/\.yaml$/, '.overrides.yaml')))
    assert.deepEqual(Object.keys(overrides), [`${target.porterApp}-core`, `${target.porterApp}-runtime`])
    for (const service of ['core', 'runtime']) {
      assert.deepEqual(overrides[`${target.porterApp}-${service}`], {
        podDisruptionBudget: {enabled: true, minAvailablePercentage: 100},
        deploymentStrategy: {kind: 'rolling', rolling: {maxUnavailable: 0, maxSurge: 1}},
      })
    }
    const core = config.services.find(service => service.name === 'core')
    assert.equal(core.instances, 1)
    assert.equal(core.cpuCores, 0.25)
    assert.equal(core.ramMegabytes, 1024)
    const runtime = config.services.find(service => service.name === 'runtime')
    assert.equal(runtime.instances, 1)
    assert.equal(runtime.cpuCores, 0.5)
    assert.equal(runtime.ramMegabytes, 2048)
    assert.deepEqual(runtime.readinessCheck, {enabled: true, httpPath: '/ready', timeoutSeconds: 5, initialDelaySeconds: 15})
    assert.equal(runtime.terminationGracePeriodSeconds, 10)
    assert.deepEqual(runtime.additionalPorts, [{port: 8000, protocol: 'UDP', name: 'udp-audio'}])
    assert.equal(config.services.find(service => service.name === 'core').ingressAnnotations['nginx.ingress.kubernetes.io/proxy-body-size'], '2g')
  }
  assert.deepEqual(configurations[0], configurations[1])
  assert.deepEqual(configurations[0], configurations[2])
})

test('frozen source owns behavior; current tooling never substitutes its own policy', t => {
  const directory = fixture(t)
  const base = path.join(directory, 'cloud-v2/deploy/porter.shared.yaml')
  writeFileSync(base, readFileSync(base, 'utf8').replace('timeoutSeconds: 5', 'timeoutSeconds: 7'))
  assert.equal(bun([renderer, '--source-root', directory, '--environment', 'prod']).status, 0)
  assert.equal(parse(path.join(directory, 'cloud-v2/porter.prod.yaml')).services[0].readinessCheck.timeoutSeconds, 7)
  rmSync(path.join(directory, 'cloud-v2/deploy/runtime-policy.yaml'))
  const result = bun([renderer, '--source-root', directory, '--environment', 'prod'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Frozen release source requires .*runtime-policy.yaml/)
})

for (const [name, filename, transform, error] of [
  ['inline env', 'porter.shared.yaml', text => text + '\nenv: {AUDIO_WORKERS: 1}\n', /unsupported field env/],
  ['service env', 'porter.shared.yaml', text => text.replace('    type: web', '    env: {AUDIO_WORKERS: 1}\n    type: web'), /cannot contain env/],
  ['environment domains', 'porter.shared.yaml', text => text.replace('    type: web', '    domains: [{name: wrong.example.com}]\n    type: web'), /cannot contain domains/],
  ['duplicate service', 'porter.shared.yaml', text => text.replace('name: runtime', 'name: core'), /exactly one core/],
  ['missing web type', 'porter.shared.yaml', text => text.replace('    type: web\n', ''), /requires a web entrypoint/],
  ['disabled readiness', 'porter.shared.yaml', text => text.replace('readinessCheck:\n      enabled: true', 'readinessCheck:\n      enabled: false'), /requires an enabled readinessCheck/],
  ['unprotected runtime', 'runtime-policy.yaml', text => text.replace('minAvailablePercentage: 100', 'minAvailablePercentage: 0'), /requires PDB100/],
  ['unprotected Core eviction', 'runtime-policy.yaml', text => text.replace(/(core:[\s\S]*minAvailablePercentage:) 100/, '$1 0'), /Core requires PDB100/],
  ['Core rollout dropping the singleton', 'runtime-policy.yaml', text => text.replace(/(core:[\s\S]*maxUnavailable:) 0/, '$1 1'), /Core requires PDB100/],
  ['Core rollout without replacement capacity', 'runtime-policy.yaml', text => text.replace(/(core:[\s\S]*maxSurge:) 1/, '$1 0'), /Core requires PDB100/],
  ['missing Core policy', 'runtime-policy.yaml', text => text.slice(0, text.indexOf('core:')), /Core policy must be an object/],
  ['placement expansion', 'runtime-policy.yaml', text => text + '  affinity: {}\n', /unsupported field affinity/],
]) {
  test(`rejects ${name} before producing deployable inputs`, t => {
    const directory = fixture(t)
    const file = path.join(directory, 'cloud-v2/deploy', filename)
    writeFileSync(file, transform(readFileSync(file, 'utf8')))
    const result = bun([renderer, '--source-root', directory, '--environment', 'dev'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, error)
  })
}

test('rejects unknown environment names', t => {
  for (const environment of ['production', 'debug', 'constructor', '__proto__']) {
    const result = bun([renderer, '--source-root', fixture(t), '--environment', environment])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unsupported Cloud V2 environment/)
  }
})

test('logical config identities still validate frozen deployment records', () => {
  for (const [environment, target] of Object.entries(CLOUD_V2_TARGETS)) {
    const sourceCommit = 'a'.repeat(40)
    const plan = {schemaVersion: 1, releaseIdentity: 'test', releaseSetId: 'mentra-test', channel: target.channel, sourceCommit}
    const record = createCloudV2DeploymentRecord({plan, environment, sourceCommit, requestedTag: sourceCommit,
      status: 'validated', completedAt: '2026-10-15T00:00:00.000Z', provenanceUrl: 'https://github.com/example/repo/actions/runs/1'})
    assert.equal(record.porter.config, `cloud-v2/porter.${environment}.yaml`)
    assert.equal(validateCloudV2DeploymentRecord({plan, record, allowValidated: true}), record)
  }
})

test('normal deployment renders frozen inputs and always passes their Helm policy', () => {
  const workflow = source('.github/workflows/reusable-coordinated-cloud-v2.yml')
  assert.match(workflow, /bun release-tooling\/\.github\/scripts\/render-cloud-v2-config.mjs\s+--source-root \.\s+--environment/)
  assert.ok(workflow.indexOf('Render shared policy') < workflow.indexOf('Validate Cloud V2 source'))
  assert.match(workflow, /--helm-overrides-file "\$overrides"/)
  assert.match(workflow, /get deployments,poddisruptionbudgets/)
  assert.match(workflow, /node release-tooling\/\.github\/scripts\/verify-runtime-deployment-policy.mjs/)
  const settledReadback = workflow.split('      - name: Require settled deployment and Runtime disruption policy\n')[1]
  assert.ok(settledReadback)
  assert.ok(settledReadback.indexOf('verify-runtime-deployment-policy.mjs') < settledReadback.indexOf('coordinated-cloud-v2-records.mjs create'))
  assert.match(workflow, /cloud-v2-runtime-policy-proof.json/)
  assert.doesNotMatch(workflow, /PORTER_APP_NAME.*==.*cloud-dev/)
  assert.match(workflow, /cancel-in-progress: false/)
  for (const filename of ['release-family-checks.yml', 'doppler-porter-health.yml']) {
    const checks = source(`.github/workflows/${filename}`)
    assert.match(checks, /cloud-v2\/deploy\/porter.shared.yaml/)
    assert.match(checks, /cloud-v2\/deploy\/runtime-policy.yaml/)
    assert.match(checks, /bun-version: "1.3.14"/)
  }
})
