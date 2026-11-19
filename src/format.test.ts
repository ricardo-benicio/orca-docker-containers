import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactDuration, cpuTone, formatBytes, formatCpu, isStopped, lookOf, memoryTone, sortRows } from './format.ts'

test('encurta as durações do docker', () => {
  assert.equal(compactDuration('Less than a second'), '<1s')
  assert.equal(compactDuration('1 second'), '1s')
  assert.equal(compactDuration('42 seconds'), '42s')
  assert.equal(compactDuration('About a minute'), '1m')
  assert.equal(compactDuration('7 minutes'), '7m')
  assert.equal(compactDuration('About an hour'), '1h')
  assert.equal(compactDuration('3 hours'), '3h')
  assert.equal(compactDuration('2 days'), '2d')
  assert.equal(compactDuration('2 weeks'), '2w')
  assert.equal(compactDuration('5 months'), '5mo')
  assert.equal(compactDuration('1 year'), '1y')
  assert.equal(compactDuration('uma coisa estranha'), 'uma coisa estranha')
})

test('container saudável em execução: ponto verde cheio, sem palavra nem realce', () => {
  assert.deepEqual(lookOf({ state: 'running', status: 'Up 3 hours' }), { tone: 'success', filled: true, word: null, code: null, age: '3h', problem: null })
  assert.deepEqual(lookOf({ state: 'running', status: 'Up 3 hours (healthy)' }), { tone: 'success', filled: true, word: null, code: null, age: '3h', problem: null })
})

test('unhealthy realça a linha; starting só avisa', () => {
  const bad = lookOf({ state: 'running', status: 'Up 2 minutes (unhealthy)' })
  assert.equal(bad.word, 'unhealthy')
  assert.equal(bad.tone, 'danger')
  assert.equal(bad.problem, 'danger')
  assert.equal(bad.age, '2m')
  const starting = lookOf({ state: 'running', status: 'Up 10 seconds (health: starting)' })
  assert.equal(starting.word, 'starting')
  assert.equal(starting.tone, 'warning')
  assert.equal(starting.problem, null)
})

test('pausado e reiniciando em laço pedem atenção', () => {
  const paused = lookOf({ state: 'paused', status: 'Up 5 minutes (Paused)' })
  assert.equal(paused.word, 'paused')
  assert.equal(paused.age, '5m')
  const loop = lookOf({ state: 'restarting', status: 'Restarting (1) 4 seconds ago' })
  assert.equal(loop.word, 'restarting')
  assert.equal(loop.code, 1)
  assert.equal(loop.problem, 'warning')
  assert.equal(lookOf({ state: 'dead', status: 'Dead' }).problem, 'danger')
})

test('parado: círculo vazio; vermelho só para falha de verdade', () => {
  const clean = lookOf({ state: 'exited', status: 'Exited (0) 2 weeks ago' })
  assert.deepEqual(clean, { tone: 'neutral', filled: false, word: 'exited', code: 0, age: '2w', problem: null })
  assert.equal(lookOf({ state: 'exited', status: 'Exited (137) 3 hours ago' }).tone, 'neutral')
  assert.equal(lookOf({ state: 'exited', status: 'Exited (143) 3 hours ago' }).tone, 'neutral')
  const crashed = lookOf({ state: 'exited', status: 'Exited (3) About an hour ago' })
  assert.equal(crashed.tone, 'danger')
  assert.equal(crashed.code, 3)
  assert.equal(crashed.age, '1h')
  assert.equal(crashed.problem, null)
})

test('estados sem status conhecido não quebram', () => {
  assert.equal(lookOf({ state: 'created', status: 'Created' }).word, 'created')
  const odd = lookOf({ state: 'removing', status: 'Removal In Progress' })
  assert.equal(odd.word, null)
  assert.equal(odd.age, '')
  assert.equal(lookOf({ state: 'running', status: '' }).tone, 'success')
})

test('parados vão para o fim e o resto fica em ordem de nome', () => {
  const rows = [
    { name: 'queue', state: 'exited' },
    { name: 'web', state: 'running' },
    { name: 'cron', state: 'restarting' },
    { name: 'api', state: 'running' },
    { name: 'old', state: 'created' },
    { name: 'db', state: 'paused' }
  ]
  assert.deepEqual(sortRows(rows).map((r) => r.name), ['api', 'cron', 'db', 'web', 'old', 'queue'])
  assert.equal(isStopped('dead'), true)
  assert.equal(isStopped('paused'), false)
  assert.deepEqual(rows[0], { name: 'queue', state: 'exited' })
})

test('formata memória e CPU curtas', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(471_040), '460 KB')
  assert.equal(formatBytes(5 * 1024 ** 2 + 300_000), '5.3 MB')
  assert.equal(formatBytes(18.5 * 1024 ** 2), '19 MB')
  assert.equal(formatBytes(1.25 * 1024 ** 3), '1.3 GB')
  assert.equal(formatCpu(0), '0%')
  assert.equal(formatCpu(0.14), '0.1%')
  assert.equal(formatCpu(3.46), '3.5%')
  assert.equal(formatCpu(87.2), '87%')
  assert.equal(formatCpu(243.5), '244%')
})

test('só destaca consumo que preocupa', () => {
  assert.equal(memoryTone({ cpu: 0, memPercent: 40 }), null)
  assert.equal(memoryTone({ cpu: 0, memPercent: 75 }), 'warning')
  assert.equal(memoryTone({ cpu: 0, memPercent: 93 }), 'danger')
  assert.equal(cpuTone({ cpu: 79, memPercent: 0 }), null)
  assert.equal(cpuTone({ cpu: 120, memPercent: 0 }), 'warning')
})
