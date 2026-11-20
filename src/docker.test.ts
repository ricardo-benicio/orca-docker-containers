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
  parseWorkingDir,
  parseSize,
  parseStats,
  containerStats,
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
  assert.deepEqual(row, { id: 'abc123def456', name: 'pg', image: 'postgres:16', state: 'running', status: 'Up 2 hours', ports: [{ host: 34032, container: 5432 }], project: 'meu-app', workingDir: null })
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
    mounts: [{ type: 'volume', source: 'pgdata', destination: '/var/lib/postgresql/data', rw: true }],
    memoryLimit: 0,
    state: { status: '', exitCode: 0, oomKilled: false, error: '', startedAt: '', finishedAt: '', restartCount: 0, health: null }
  })
  assert.equal(JSON.stringify(info).includes('segredo'), false)
  assert.equal(parseInspect('não é json'), null)
  assert.equal(parseInspect('[]'), null)
})

const statsLine = '{"BlockIO":"0B / 0B","CPUPerc":"0.00%","Container":"77c324ab494951a5c8fc3ba9d64b10755fa5a273a5414fc6c109d779153be44e","ID":"77c324ab4949","MemPerc":"0.00%","MemUsage":"460KiB / 13.56GiB","Name":"orca-teste-stats","NetIO":"1.1kB / 126B","PIDs":"1"}'

test('converte tamanhos do docker em bytes', () => {
  assert.equal(parseSize('460KiB'), 471_040)
  assert.equal(parseSize('18.5MiB'), Math.round(18.5 * 1024 ** 2))
  assert.equal(parseSize('13.56GiB'), Math.round(13.56 * 1024 ** 3))
  assert.equal(parseSize('1.1kB'), 1100)
  assert.equal(parseSize('0B'), 0)
  assert.equal(parseSize('--'), null)
  assert.equal(parseSize('abc'), null)
  assert.equal(parseSize('3 furlongs'), null)
})

test('lê CPU e memória por id curto e ignora linhas sem dados', () => {
  const other = '{"ID":"aaaaaaaaaaaa","CPUPerc":"243.50%","MemUsage":"1.5GiB / 2GiB","MemPerc":"75.00%"}'
  const empty = '{"ID":"bbbbbbbbbbbb","CPUPerc":"--","MemUsage":"-- / --","MemPerc":"--"}'
  const stats = parseStats([statsLine, other, empty, 'não é json', '', '{"CPUPerc":"1%"}'].join('\n'))
  assert.deepEqual(Object.keys(stats).sort(), ['77c324ab4949', 'aaaaaaaaaaaa'])
  assert.deepEqual(stats['77c324ab4949'], { cpu: 0, memBytes: 471_040, memLimit: Math.round(13.56 * 1024 ** 3), memPercent: 0 })
  assert.equal(stats.aaaaaaaaaaaa!.cpu, 243.5)
  assert.equal(stats.aaaaaaaaaaaa!.memPercent, 75)
})

test('pede uma única leitura, sem ficar ouvindo', async () => {
  const calls: string[][] = []
  setRunner(async (args) => (calls.push(args), statsLine))
  const stats = await containerStats()
  setRunner()
  assert.deepEqual(calls, [['stats', '--no-stream', '--format', '{{json .}}']])
  assert.equal(stats['77c324ab4949']!.memBytes, 471_040)
})

test('lê a pasta do projeto compose nos labels', () => {
  const labels = 'a=b,com.docker.compose.project=shop,com.docker.compose.project.working_dir=/home/a/shop,com.docker.compose.service=web'
  assert.equal(parseWorkingDir(labels), '/home/a/shop')
  assert.equal(parseProject(labels), 'shop', 'o label working_dir não confunde o do projeto')
  assert.equal(parseWorkingDir('a=b'), null)
  assert.equal(parseWorkingDir('com.docker.compose.project.working_dir='), null)
  const row = parseLine(JSON.stringify({ ID: 'abc123def456', Names: 'shop-web-1', Labels: labels }))
  assert.equal(row?.workingDir, '/home/a/shop')
  assert.equal(parseLine(JSON.stringify({ ID: 'abc123def456', Names: 'solo', Labels: '' }))?.workingDir, null)
})

// Saídas reais de `docker inspect` (recortadas) de containers que estouraram memória, não subiram e ficaram unhealthy.
const diag = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify([{ Id: 'a'.repeat(64), Name: '/x', Created: '2026-11-20T00:00:00Z', Path: 'sleep', Args: ['5'], Config: { Image: 'busybox', Env: ['SENHA=segredo'], Labels: { token: 'segredo' } }, HostConfig: { RestartPolicy: { Name: 'no' }, Memory: 0 }, NetworkSettings: { Networks: {} }, Mounts: [], RestartCount: 0, State: state, ...extra }])

test('o diagnóstico mostra OOM, código de saída, restarts e limite de memória', () => {
  const info = parseInspect(diag({ Status: 'exited', ExitCode: 137, OOMKilled: true, Error: '', StartedAt: '2026-11-20T00:15:30.265452404Z', FinishedAt: '2026-11-20T00:15:30.536597498Z' }, { RestartCount: 3, HostConfig: { RestartPolicy: { Name: 'always' }, Memory: 16_777_216 } }))
  assert.equal(info?.memoryLimit, 16_777_216)
  assert.deepEqual(info?.state, { status: 'exited', exitCode: 137, oomKilled: true, error: '', startedAt: '2026-11-20T00:15:30.265452404Z', finishedAt: '2026-11-20T00:15:30.536597498Z', restartCount: 3, health: null })
})

test('o diagnóstico traz o erro de execução e o último health check, limpos e curtos', () => {
  const bad = parseInspect(diag({ Status: 'created', ExitCode: 127, Error: 'OCI runtime create failed: exec: "/nao-existe": stat /nao-existe: no such file or directory\u0000\n' + 'x'.repeat(900) }))
  assert.ok(bad?.state.error.startsWith('OCI runtime create failed'))
  assert.equal(bad?.state.error.length, 300)
  assert.equal(/[\u0000-\u001f]/.test(bad?.state.error ?? ''), false)
  const sick = parseInspect(diag({ Status: 'running', ExitCode: 0, Health: { Status: 'unhealthy', FailingStreak: 4, Log: [{ ExitCode: 1, Output: 'antigo\n' }, { ExitCode: 1, Output: 'falhou no check\n' }] } }))
  assert.deepEqual(sick?.state.health, { status: 'unhealthy', failingStreak: 4, lastOutput: 'falhou no check' })
  const noLog = parseInspect(diag({ Status: 'running', Health: { Status: 'starting', FailingStreak: 0 } }))
  assert.deepEqual(noLog?.state.health, { status: 'starting', failingStreak: 0, lastOutput: '' })
})

test('o diagnóstico nunca leva ambiente nem labels', () => {
  const info = parseInspect(diag({ Status: 'running' }))
  assert.equal(JSON.stringify(info).includes('segredo'), false)
})
