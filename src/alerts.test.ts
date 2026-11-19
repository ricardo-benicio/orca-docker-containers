import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertFor, shouldSend } from './alerts.ts'
import { parseEvent, type DockerEvent } from './events.ts'

const event = (patch: Partial<DockerEvent>): DockerEvent => ({ action: 'die', id: 'a'.repeat(64), name: 'api', project: 'shop', exitCode: 1, ...patch })

test('lê um evento do docker em JSON', () => {
  const line = JSON.stringify({ status: 'die', Type: 'container', Action: 'die', Actor: { ID: 'abc', Attributes: { name: 'shop-api-1', exitCode: '137', 'com.docker.compose.project': 'shop', image: 'x' } } })
  assert.deepEqual(parseEvent(line), { action: 'die', id: 'abc', name: 'shop-api-1', project: 'shop', exitCode: 137 })
  assert.equal(parseEvent('lixo'), null)
  assert.equal(parseEvent('{"Type":"container"}'), null)
  assert.equal(parseEvent(JSON.stringify({ Action: 'health_status: unhealthy', Actor: { ID: 'z', Attributes: { name: 'db' } } }))?.project, null)
})

test('avisa só de queda real, não de parada normal', () => {
  assert.equal(alertFor(event({ exitCode: 1 }))?.kind, 'crashed')
  assert.equal(alertFor(event({ exitCode: 2 }))?.kind, 'crashed')
  for (const code of [0, 137, 143]) assert.equal(alertFor(event({ exitCode: code })), null, `exit ${code}`)
  assert.equal(alertFor(event({ exitCode: null })), null)
  assert.equal(alertFor(event({ action: 'start', exitCode: null })), null)
  assert.equal(alertFor(event({ action: 'oom', exitCode: null }))?.kind, 'oom')
  assert.equal(alertFor(event({ action: 'health_status: unhealthy', exitCode: null }))?.kind, 'unhealthy')
  assert.equal(alertFor(event({ action: 'health_status: healthy', exitCode: null })), null)
})

test('usa o id curto quando o evento não traz o nome', () => {
  assert.equal(alertFor(event({ name: '', exitCode: 1 }))?.name, 'a'.repeat(12))
})

test('não repete o mesmo aviso dentro de um minuto', () => {
  const last = new Map<string, number>()
  const alert = alertFor(event({ exitCode: 1 }))!
  assert.equal(shouldSend(last, alert, 1_000), true)
  assert.equal(shouldSend(last, alert, 30_000), false)
  assert.equal(shouldSend(last, { ...alert, name: 'outro' }, 30_000), true)
  assert.equal(shouldSend(last, alert, 62_000), true)
})
