import { assert, test } from 'orca/testing'
import { isValidAction, isValidId, parseLine, parsePorts, parseProject } from './docker'

test('resume portas publicadas e ignora duplicadas IPv6', () => {
  assert.deepEqual(parsePorts('0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp'), ['5432→5432'])
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
  assert.deepEqual(row, { id: 'abc123def456', name: 'pg', image: 'postgres:16', state: 'running', status: 'Up 2 hours', ports: ['34032→5432'], project: 'meu-app' })
  assert.equal(parseLine('não é json'), null)
})

test('valida ids e ações antes de chamar o docker', () => {
  assert.equal(isValidId('abc123def456'), true)
  assert.equal(isValidId('--all'), false)
  assert.equal(isValidAction('restart'), true)
  assert.equal(isValidAction('rm'), false)
})
