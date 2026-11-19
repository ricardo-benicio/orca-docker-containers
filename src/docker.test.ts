// Testes puros (node:test): rodam com `orca plugin test .` e também com `node --test src/docker.test.ts` no CI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyError,
  configureDocker,
  dockerArgs,
  dockerCommandLine,
  followLogsCommand,
  parseInspect,
  shellCommand,
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

test('monta linhas de terminal seguras, com binário e contexto configurados', () => {
  try {
    assert.equal(followLogsCommand('abc123def456'), 'docker logs -f --tail 200 abc123def456')
    assert.equal(shellCommand('abc123def456'), "docker exec -it abc123def456 sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'")
    configureDocker({ path: '/opt/bin/docker', context: 'colima' })
    assert.equal(dockerCommandLine(['ps']), '/opt/bin/docker --context colima ps')
    assert.deepEqual(dockerArgs(['ps']), ['--context', 'colima', 'ps'])
    configureDocker({ path: 'docker; rm -rf ~', context: 'x; id' })
    assert.equal(dockerCommandLine(['ps']), 'docker ps')
  } finally {
    configureDocker({ path: 'docker', context: '' })
  }
})

test('o runner recebe o contexto configurado', async () => {
  const calls: string[][] = []
  setRunner(async (args) => (calls.push(args), ''))
  try {
    await containerAction('abc123def456', 'stop')
    assert.deepEqual(calls.at(-1), ['stop', 'abc123def456'])
  } finally {
    setRunner()
  }
})

test('lê do docker inspect só os campos seguros, sem variáveis de ambiente', () => {
  const raw = JSON.stringify([
    {
      Id: 'f'.repeat(64),
      Name: '/shop-db-1',
      Created: '2026-11-19T18:00:00.123Z',
      Path: 'postgres',
      Args: ['-c', 'fsync=off'],
      Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=segredo'], Labels: { token: 'segredo' } },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      NetworkSettings: { Networks: { shop_default: { IPAddress: '172.18.0.2' } } },
      Mounts: [{ Type: 'volume', Name: 'pgdata', Source: '/var/lib/docker/volumes/pgdata/_data', Destination: '/var/lib/postgresql/data', RW: true }]
    }
  ])
  const info = parseInspect(raw)
  assert.deepEqual(info, {
    id: 'ffffffffffff',
    name: 'shop-db-1',
    image: 'postgres:16',
    created: '2026-11-19T18:00:00.123Z',
    command: 'postgres -c fsync=off',
    restart: 'unless-stopped',
    networks: [{ name: 'shop_default', ip: '172.18.0.2' }],
    mounts: [{ type: 'volume', source: 'pgdata', destination: '/var/lib/postgresql/data', rw: true }]
  })
  assert.equal(JSON.stringify(info).includes('segredo'), false)
  assert.equal(parseInspect('não é json'), null)
  assert.equal(parseInspect('[]'), null)
})
