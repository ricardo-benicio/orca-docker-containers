// Testes puros (node:test): rodam com `orca plugin test .` e também com `node --test src/docker.test.ts` no CI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyError,
  containerAction,
  isValidAction,
  isValidId,
  isValidProject,
  listContainers,
  parseLine,
  parsePorts,
  parseProject,
  projectAction,
  setRunner
} from './docker.ts'

test('resume portas publicadas e ignora duplicadas IPv6', () => {
  assert.deepEqual(parsePorts('0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp'), [{ host: 5432, container: 5432 }])
  assert.deepEqual(parsePorts(''), [])
})

test('lê o projeto do compose nos labels', () => {
  assert.equal(parseProject('a=b,com.docker.compose.project=meu-app,c=d'), 'meu-app')
  assert.equal(parseProject('a=b'), null)
})

test('converte uma linha do docker ps', () => {
  const row = parseLine(
    JSON.stringify({ ID: 'abc123def456', Names: 'pg', Image: 'postgres:16', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:34032->5432/tcp', Labels: 'com.docker.compose.project=meu-app' })
  )
  assert.deepEqual(row, { id: 'abc123def456', name: 'pg', image: 'postgres:16', state: 'running', status: 'Up 2 hours', ports: [{ host: 34032, container: 5432 }], project: 'meu-app' })
  assert.equal(parseLine('não é json'), null)
})

test('valida ids, projetos e ações antes de chamar o docker', () => {
  assert.equal(isValidId('abc123def456'), true)
  assert.equal(isValidId('--all'), false)
  assert.equal(isValidProject('meu-app_1.x'), true)
  assert.equal(isValidProject('--all'), false)
  assert.equal(isValidProject('a b'), false)
  assert.equal(isValidAction('restart'), true)
  assert.equal(isValidAction('rm'), false)
})

test('classifica as falhas do docker', () => {
  assert.equal(classifyError('ENOENT', 'spawn docker ENOENT'), 'docker_missing')
  assert.equal(classifyError(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), 'daemon_down')
  assert.equal(classifyError(1, 'permission denied while trying to connect to the Docker daemon socket'), 'permission')
  assert.equal(classifyError(1, 'algo estranho'), 'unknown')
})

test('lista, age em um container e em todo um projeto pelo runner', async () => {
  const calls: string[][] = []
  setRunner(async (args) => {
    calls.push(args)
    if (args[0] === 'ps' && args.includes('-q')) return `${'a'.repeat(64)}\n${'b'.repeat(64)}\nnao-e-id\n`
    if (args[0] === 'ps') return JSON.stringify({ ID: 'abc123def456', Names: 'pg', State: 'running' }) + '\n'
    return ''
  })
  try {
    assert.equal((await listContainers()).length, 1)
    await containerAction('abc123def456', 'stop')
    assert.deepEqual(calls.at(-1), ['stop', 'abc123def456'])
    assert.equal(await projectAction('meu-app', 'restart'), 2)
    assert.deepEqual(calls.at(-1), ['restart', 'a'.repeat(64), 'b'.repeat(64)])
    assert.ok(calls.some((c) => c.includes('label=com.docker.compose.project=meu-app')))
  } finally {
    setRunner()
  }
})
