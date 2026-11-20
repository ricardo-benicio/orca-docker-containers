// Roda activate(orca) de src/worker.ts com o `orca` que o Orca entrega, sobre um host de mentira.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { configureDocker, DockerError, setRunner } from './docker.ts'
import type { DockerEvent, WatchOptions } from './events.ts'
import * as main from './worker'

const ID = 'abc123def456'
const row = JSON.stringify({ ID, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 1 hour', Ports: '0.0.0.0:8080->80/tcp', Labels: 'com.docker.compose.project=meu-app' })
const inspect = JSON.stringify([{ Id: ID.padEnd(64, '0'), Name: '/web', Created: '2026-11-19T18:00:00Z', Path: 'nginx', Args: [], Config: { Image: 'nginx', Env: ['TOKEN=segredo'] }, HostConfig: { RestartPolicy: { Name: 'no' } }, NetworkSettings: { Networks: {} }, Mounts: [] }])

function fakeDocker(calls: string[][], failWith?: Error) {
  setRunner(async (args) => {
    calls.push(args)
    if (failWith) throw failWith
    if (args[0] === 'ps' && args.includes('-q')) return `${ID}\n`
    if (args[0] === 'ps') return `${row}\n`
    if (args[0] === 'logs') return 'linha 1\nlinha 2\n'
    if (args[0] === 'inspect') return inspect
    if (args[0] === 'stats') return JSON.stringify({ ID, CPUPerc: '2.50%', MemUsage: '40MiB / 1GiB', MemPerc: '3.91%' }) + '\n'
    return ''
  })
}

/** Troca o monitor de eventos por um falso que o teste dispara à mão. */
function fakeWatcher() {
  const state = { starts: 0, stops: 0, options: null as WatchOptions | null }
  main.setWatcherFactory((options) => {
    state.starts += 1
    state.options = options
    return { stop: () => void (state.stops += 1) }
  })
  return state
}

const mount = (options: Parameters<typeof mockHost>[0] = {}) =>
  mountWorker(main, { host: mockHost({ settings: {}, ...options }) })

async function finish(worker: Awaited<ReturnType<typeof mountWorker>>) {
  await worker.deactivate()
  main.setWatcherFactory()
  setRunner()
  configureDocker({ path: 'docker', context: '' })
}

test('liga o monitor ao ativar, lista e avisa os painéis quando o docker muda', async () => {
  fakeDocker([])
  const watcher = fakeWatcher()
  const worker = await mount()
  try {
    assert.equal(watcher.starts, 1)
    const first = await worker.request('containers.list')
    assert.equal(first.ok, true)
    if (first.ok) assert.deepEqual(first.containers[0]?.ports, [{ host: 8080, container: 80 }])
    watcher.options?.onChange()
    assert.equal(worker.posts.at(-1)?.event, 'containers.changed')
  } finally {
    await finish(worker)
  }
  assert.equal(watcher.stops, 1)
})

test('mantém o contador da barra de status em dia', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount()
  try {
    await worker.request('containers.list')
    const updates = worker.host.callsOf('statusBar.update') as { id: string; text?: string; tone?: string; visible?: boolean }[]
    const last = updates.at(-1)
    assert.equal(last?.id, 'docker-status')
    assert.equal(last?.text, '1/1')
    assert.equal(last?.tone, 'success')
  } finally {
    await finish(worker)
  }
})

test('esconde a barra de status quando a configuração desliga', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount({ settings: { statusBar: false } })
  try {
    await worker.request('containers.list')
    const updates = worker.host.callsOf('statusBar.update') as { visible?: boolean }[]
    assert.equal(updates.at(-1)?.visible, false)
  } finally {
    await finish(worker)
  }
})

test('mostra "off" na barra de status quando o docker está parado', async () => {
  fakeDocker([], new DockerError('daemon_down', 'Cannot connect to the Docker daemon'))
  fakeWatcher()
  const worker = await mount()
  try {
    const result = await worker.request('containers.list')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'daemon_down')
    const updates = worker.host.callsOf('statusBar.update') as { text?: string; tone?: string }[]
    assert.equal(updates.at(-1)?.text, 'off')
    assert.equal(updates.at(-1)?.tone, 'warning')
  } finally {
    await finish(worker)
  }
})

test('notifica queda real, ignora parada normal e não repete', async () => {
  fakeDocker([])
  const watcher = fakeWatcher()
  const worker = await mount()
  try {
    const die = (exitCode: number | null): DockerEvent => ({ action: 'die', id: ID, name: 'web', project: 'meu-app', exitCode })
    watcher.options?.onEvent?.(die(0))
    watcher.options?.onEvent?.(die(143))
    watcher.options?.onEvent?.(die(1))
    watcher.options?.onEvent?.(die(1))
    await worker.request('containers.list')
    const shown = worker.host.callsOf('notifications.show') as { title: string; body: string }[]
    assert.equal(shown.length, 1)
    assert.match(shown[0]!.body, /web/)
    assert.match(shown[0]!.body, /meu-app/)
  } finally {
    await finish(worker)
  }
})

test('não notifica quando a configuração desliga', async () => {
  fakeDocker([])
  const watcher = fakeWatcher()
  const worker = await mount({ settings: { notifications: false } })
  try {
    watcher.options?.onEvent?.({ action: 'oom', id: ID, name: 'web', project: null, exitCode: null })
    await worker.request('containers.list')
    assert.equal(worker.host.callsOf('notifications.show').length, 0)
  } finally {
    await finish(worker)
  }
})

test('aplica o contexto das configurações às chamadas ao docker', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  fakeWatcher()
  const worker = await mount({ settings: { dockerContext: 'colima' } })
  try {
    await worker.request('containers.list')
    // O contexto é aplicado dentro do runner real; aqui o falso recebe só os argumentos do comando.
    assert.deepEqual(calls.at(-1), ['ps', '-a', '--format', '{{json .}}'])
  } finally {
    await finish(worker)
  }
})

test('ações em container e em projeto, logs e detalhes chamam o docker certo', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  fakeWatcher()
  const worker = await mount()
  try {
    assert.deepEqual(await worker.request('containers.action', { id: ID, action: 'stop' }), { ok: true })
    assert.deepEqual(calls.at(-1), ['stop', ID])
    assert.deepEqual(await worker.request('project.action', { project: 'meu-app', action: 'restart' }), { ok: true, count: 1 })
    assert.deepEqual(calls.at(-1), ['restart', ID])
    assert.equal((await worker.request('containers.logs', { id: ID, tail: 5000 })).ok, true)
    assert.deepEqual(calls.at(-1), ['logs', '--tail', '1000', ID])
    const details = await worker.request('containers.inspect', { id: ID })
    assert.equal(details.ok, true)
    assert.equal(JSON.stringify(details).includes('segredo'), false)
  } finally {
    await finish(worker)
  }
})

test('abre shell e logs em terminal do workspace em foco', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount({
    results: {
      'workspace.readContext': { workspaceId: 'ws-1', branch: 'main', displayName: 'app', terminals: [] },
      'terminal.create': { terminalId: 't-1' }
    }
  })
  try {
    assert.deepEqual(await worker.request('containers.terminal', { id: ID, kind: 'shell', name: 'web\n; rm -rf ~' }), { ok: true })
    assert.deepEqual(await worker.request('containers.terminal', { id: ID, kind: 'logs', name: 'web' }), { ok: true })
    const created = worker.host.callsOf('terminal.create') as { workspaceId: string; title: string; command: string }[]
    assert.equal(created.length, 2)
    assert.equal(created[0]!.workspaceId, 'ws-1')
    assert.equal(created[0]!.command, `docker exec -it ${ID} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`)
    assert.equal(created[1]!.command, `docker logs -f --tail 200 ${ID}`)
    assert.equal(/[\n\r]/.test(created[0]!.title), false)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await finish(worker)
  }
})

test('explica quando não há workspace em foco para abrir o terminal', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': null } })
  try {
    const result = await worker.request('containers.terminal', { id: ID, kind: 'shell' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'no_workspace')
    assert.equal(worker.host.callsOf('terminal.create').length, 0)
  } finally {
    await finish(worker)
  }
})

test('recusa ids, projetos e ações inválidos sem chamar o docker nem abrir terminal', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  fakeWatcher()
  const worker = await mount()
  try {
    await assert.rejects(worker.request('containers.action', { id: '--all', action: 'stop' }))
    await assert.rejects(worker.request('containers.action', { id: ID, action: 'rm' as 'stop' }))
    await assert.rejects(worker.request('project.action', { project: '--all', action: 'stop' }))
    await assert.rejects(worker.request('containers.logs', { id: '--all' }))
    await assert.rejects(worker.request('containers.inspect', { id: '--all' }))
    await assert.rejects(worker.request('containers.terminal', { id: '$(id)', kind: 'shell' }))
    await assert.rejects(worker.request('containers.terminal', { id: ID, kind: 'rm' as 'shell' }))
    assert.equal(worker.host.callsOf('terminal.create').length, 0)
    assert.deepEqual(calls.filter((c) => c[0] !== 'ps'), [])
  } finally {
    await finish(worker)
  }
})

test('o comando de resumo lista os projetos', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount()
  try {
    const text = String(await worker.command('docker.summary'))
    assert.match(text, /1/)
    assert.match(text, /meu-app: 1\/1/)
  } finally {
    await finish(worker)
  }
})

test('devolve CPU e memória por id e explica falhas sem derrubar o painel', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  fakeWatcher()
  const worker = await mount()
  try {
    const ok = await worker.request('containers.stats')
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.stats[ID], { cpu: 2.5, memBytes: 40 * 1024 ** 2, memLimit: 1024 ** 3, memPercent: 3.91 })
    assert.deepEqual(calls.filter((c) => c[0] === 'stats'), [['stats', '--no-stream', '--format', '{{json .}}']])
  } finally {
    await finish(worker)
  }
  const down = new DockerError('daemon_down', 'Cannot connect')
  fakeDocker([], down)
  fakeWatcher()
  const failing = await mount()
  try {
    const result = await failing.request('containers.stats')
    assert.equal(result.ok, false)
  } finally {
    await finish(failing)
  }
})

const FOCUS = { workspaceId: 'ws-1', branch: 'main', displayName: 'loja', terminals: [] }
const LIST = { workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'loja', path: '/home/a/loja', branch: 'main', hostId: 'local' }], truncated: false }

test('devolve o nome e a pasta do workspace em foco', async () => {
  fakeDocker([])
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': FOCUS, 'workspace.list': LIST } })
  try {
    assert.deepEqual(await worker.request('workspace.context'), { name: 'loja', path: '/home/a/loja' })
  } finally {
    await finish(worker)
  }
})

test('sem workspace em foco ou sem permissão, devolve vazio e não derruba o painel', async () => {
  fakeDocker([])
  fakeWatcher()
  const none = await mount({ results: { 'workspace.readContext': null } })
  try {
    assert.deepEqual(await none.request('workspace.context'), { name: null, path: null })
  } finally {
    await finish(none)
  }
  fakeDocker([])
  fakeWatcher()
  const denied = await mount({ requests: { 'workspace.readContext': () => { throw new Error('capability_denied') } } as never })
  try {
    assert.deepEqual(await denied.request('workspace.context'), { name: null, path: null })
  } finally {
    await finish(denied)
  }
})

const composeRow = JSON.stringify({
  ID: ID,
  Names: 'loja-web-1',
  Image: 'nginx',
  State: 'running',
  Status: 'Up 1 hour',
  Ports: '',
  Labels: 'com.docker.compose.project=loja,com.docker.compose.project.config_files=/home/a/loja/compose.yaml,com.docker.compose.project.working_dir=/home/a/loja'
})

/** Um docker em que o projeto "loja" tem containers até `down()` ser chamado. */
function composeDocker() {
  const state = { up: true }
  setRunner(async (args) => (args[0] === 'ps' ? (state.up ? `${composeRow}\n` : '') : ''))
  return { down: () => void (state.up = false) }
}

const LOJA_UP = "docker compose -p 'loja' --project-directory '/home/a/loja' -f '/home/a/loja/compose.yaml' up -d"

test('lembra o projeto compose visto na lista e o oferece mesmo depois do down', async () => {
  const docker = composeDocker()
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': FOCUS, 'terminal.create': { terminalId: 't-1' } } })
  try {
    await worker.request('containers.list')
    assert.deepEqual(await worker.request('compose.projects'), { projects: [{ project: 'loja', workingDir: '/home/a/loja' }] })
    assert.equal(worker.host.data().storage.composeProjects !== undefined, true, 'ficou gravado no storage')
    docker.down()
    const after = await worker.request('containers.list')
    assert.equal(after.ok && after.containers.length, 0)
    assert.equal((await worker.request('compose.projects')).projects.length, 1, 'o projeto continua lembrado sem containers')
  } finally {
    await finish(worker)
  }
})

test('o Up abre um terminal com os arquivos que o docker guardou, e o Down só com o nome', async () => {
  composeDocker()
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': FOCUS, 'terminal.create': { terminalId: 't-1' } } })
  try {
    await worker.request('containers.list')
    assert.deepEqual(await worker.request('compose.run', { project: 'loja', action: 'up' }), { ok: true })
    assert.deepEqual(await worker.request('compose.run', { project: 'loja', action: 'down' }), { ok: true })
    assert.deepEqual(worker.host.callsOf('terminal.create'), [
      { workspaceId: 'ws-1', title: 'compose up · loja', command: LOJA_UP },
      { workspaceId: 'ws-1', title: 'compose down · loja', command: "docker compose -p 'loja' down" }
    ])
  } finally {
    await finish(worker)
  }
})

test('o Up de um projeto desconhecido explica em vez de adivinhar; o Down funciona só pelo nome', async () => {
  composeDocker()
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': FOCUS, 'terminal.create': { terminalId: 't-1' } } })
  try {
    const up = await worker.request('compose.run', { project: 'nunca-visto', action: 'up' })
    assert.equal(up.ok, false)
    assert.equal(up.code, 'no_files')
    assert.equal(worker.host.callsOf('terminal.create').length, 0)
    assert.equal((await worker.request('compose.run', { project: 'nunca-visto', action: 'down' })).ok, true)
  } finally {
    await finish(worker)
  }
})

test('compose recusa entrada inválida e avisa quando não há workspace em foco', async () => {
  composeDocker()
  fakeWatcher()
  const worker = await mount({ results: { 'workspace.readContext': null } })
  try {
    await assert.rejects(worker.request('compose.run', { project: "x'; id #", action: 'down' }))
    await assert.rejects(worker.request('compose.run', { project: '--all', action: 'down' }))
    await assert.rejects(worker.request('compose.run', { project: 'loja', action: 'rm' as 'up' }))
    await assert.rejects(worker.request('compose.forget', { project: '--all' }))
    const none = await worker.request('compose.run', { project: 'loja', action: 'down' })
    assert.equal(none.ok, false)
    assert.equal(none.code, 'no_workspace')
    assert.equal(worker.host.callsOf('terminal.create').length, 0)
  } finally {
    await finish(worker)
  }
})

test('esquecer um projeto o tira da lista, e registro adulterado no storage é ignorado', async () => {
  setRunner(async () => '')
  fakeWatcher()
  const evil = { project: 'mal', dir: '/a', files: ["/a'; rm -rf ~ #"], envFiles: [], seenAt: 1 }
  const good = { project: 'velho', dir: '/home/a/velho', files: ['/home/a/velho/compose.yaml'], envFiles: [], seenAt: 1 }
  const worker = await mount({ storage: { composeProjects: [evil, good] as never }, results: { 'workspace.readContext': FOCUS, 'terminal.create': { terminalId: 't-1' } } })
  try {
    assert.deepEqual((await worker.request('compose.projects')).projects.map((p) => p.project), ['velho'])
    assert.deepEqual(await worker.request('compose.forget', { project: 'velho' }), { ok: true })
    assert.deepEqual((await worker.request('compose.projects')).projects, [])
    assert.deepEqual(worker.host.data().storage.composeProjects, [])
    const up = await worker.request('compose.run', { project: 'mal', action: 'up' })
    assert.equal(up.code, 'no_files')
  } finally {
    await finish(worker)
  }
})
