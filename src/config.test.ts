import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, isSafeContext, isSafePath, normalizeConfig } from './config.ts'

test('sem configuração usa os padrões', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULTS)
  assert.deepEqual(normalizeConfig({}), DEFAULTS)
})

test('aceita valores válidos e limita o intervalo', () => {
  const config = normalizeConfig({ pollSeconds: 5, dockerPath: '/usr/local/bin/docker', dockerContext: ' colima ', notifications: false, statusBar: false })
  assert.deepEqual(config, { pollSeconds: 10, dockerPath: '/usr/local/bin/docker', dockerContext: 'colima', notifications: false, statusBar: false })
  assert.equal(normalizeConfig({ pollSeconds: 9999 }).pollSeconds, 300)
  assert.equal(normalizeConfig({ pollSeconds: 'x' }).pollSeconds, 30)
})

test('rejeita binário e contexto que poderiam virar injeção no terminal', () => {
  for (const bad of ['docker; rm -rf ~', 'docker && curl x', '$(id)', 'a b', '`id`', 'docker\nid', '']) {
    assert.equal(isSafePath(bad), false, bad)
    assert.equal(normalizeConfig({ dockerPath: bad }).dockerPath, 'docker')
  }
  for (const bad of ['ctx; id', '-x', '$(id)', 'a b', '../x']) {
    assert.equal(isSafeContext(bad), false, bad)
    assert.equal(normalizeConfig({ dockerContext: bad }).dockerContext, '')
  }
  assert.equal(isSafeContext('remote-ssh_1.prod'), true)
})
