// `orca plugin test .` roda isto em Node com o mesmo runtime e as mesmas checagens do Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ContainerRow, ListResult } from './protocol'

const web: ContainerRow = { id: 'a'.repeat(12), name: 'web', image: 'nginx', state: 'running', status: 'Up 1 hour', ports: [{ host: 8080, container: 80 }], project: 'meu-app' }
const db: ContainerRow = { id: 'b'.repeat(12), name: 'db', image: 'postgres:16', state: 'exited', status: 'Exited (0) 2 days ago', ports: [], project: 'meu-app' }
const sick: ContainerRow = { id: 'd'.repeat(12), name: 'api', image: 'caddy:2', state: 'running', status: 'Up 2 minutes (unhealthy)', ports: [], project: 'meu-app' }
const crashed: ContainerRow = { id: 'e'.repeat(12), name: 'job', image: 'busybox', state: 'exited', status: 'Exited (3) About an hour ago', ports: [], project: null }
const solo: ContainerRow = { id: 'c'.repeat(12), name: 'solo', image: 'redis', state: 'running', status: 'Up 5 minutes', ports: [], project: null }

/** Há, em qualquer parte da árvore desenhada (children, title, label...), um valor de texto exatamente igual. */
function shows(view: { tree(): unknown }, text: string): boolean {
  return JSON.stringify(view.tree()).includes(JSON.stringify(text))
}

function hostWith(list: () => ListResult, extra: Record<string, unknown> = {}) {
  return mockHost({ requests: { 'containers.list': list, ...extra } as never })
}

test('agrupa por projeto, mostra o contador e os avulsos', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [web, db, solo], at: 1 })) })
  assert.ok(shows(view, '2/3 active'))
  assert.ok(shows(view, 'meu-app'))
  assert.ok(shows(view, '1/2'))
  assert.ok(shows(view, 'Standalone'))
  assert.ok(shows(view, '1/1'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('parar um container e agir em todo o projeto chamam o worker', async () => {
  const seen: unknown[] = []
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web, db], at: 1 }), {
      'containers.action': (input: unknown) => (seen.push(input), { ok: true }),
      'project.action': (input: unknown) => (seen.push(input), { ok: true, count: 2 })
    })
  })
  await view.press({ label: 'Stop web' })
  await view.press({ label: 'Restart all' })
  assert.deepEqual(seen, [
    { id: web.id, action: 'stop' },
    { project: 'meu-app', action: 'restart' }
  ])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('abre a porta publicada no navegador após um clique', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [web], at: 1 })) })
  await view.press({ label: 'Open localhost:8080' })
  assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: 'http://localhost:8080' }])
  await view.unmount()
})

test('recarrega a lista quando o worker avisa que o docker mudou', async () => {
  let containers = [web]
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers, at: 1 })) })
  assert.ok(shows(view, '1/1'))
  containers = [web, db]
  await view.post('containers.changed', { at: 2 })
  assert.ok(shows(view, '1/2'))
  await view.unmount()
})

test('explica quando o docker está parado ou ausente', async () => {
  const down = await mount(panel, { host: hostWith(() => ({ ok: false, code: 'daemon_down', error: 'Cannot connect' })) })
  assert.ok(shows(down, 'Docker is not running'))
  await down.unmount()
  const missing = await mount(panel, { host: hostWith(() => ({ ok: false, code: 'docker_missing', error: 'spawn docker ENOENT' })) })
  assert.ok(shows(missing, 'Docker not found'))
  await missing.unmount()
})

test('o filtro e o interruptor reduzem a lista', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [web, db, solo], at: 1 })) })
  assert.ok(shows(view, 'db') && shows(view, 'web') && shows(view, 'solo'))
  await view.toggle({ label: 'Running only' })
  assert.equal(shows(view, 'db'), false)
  await view.type({ label: 'Filter containers' }, 'redis')
  assert.ok(shows(view, 'solo'))
  assert.equal(shows(view, 'web'), false)
  await view.unmount()
})

const info = { id: 'a'.repeat(12), name: 'web', image: 'nginx', created: '2026-11-19T18:00:00Z', command: 'nginx -g daemon off;', restart: 'unless-stopped', networks: [{ name: 'meu-app_default', ip: '172.18.0.2' }], mounts: [{ type: 'volume', source: 'data', destination: '/data', rw: false }] }

test('mostra rede, volumes e comando nos detalhes, sem segredos', async () => {
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web], at: 1 }), { 'containers.inspect': () => ({ ok: true, info }) })
  })
  await view.press({ label: 'Details of web' })
  assert.ok(shows(view, 'meu-app_default (172.18.0.2)'))
  assert.ok(shows(view, 'data → /data (ro)'))
  assert.ok(shows(view, 'unless-stopped'))
  await view.press({ label: 'Close details' })
  assert.equal(shows(view, 'unless-stopped'), false)
  await view.unmount()
})

test('abre shell e logs em terminal pelo worker, só com o container ativo', async () => {
  const seen: unknown[] = []
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web, db], at: 1 }), {
      'containers.inspect': () => ({ ok: true, info }),
      'containers.terminal': (input: unknown) => (seen.push(input), { ok: true })
    })
  })
  await view.press({ label: 'Details of web' })
  await view.press({ text: 'Open shell' })
  await view.press({ text: 'Follow logs in terminal' })
  assert.deepEqual(seen, [
    { id: web.id, kind: 'shell', name: 'web' },
    { id: web.id, kind: 'logs', name: 'web' }
  ])
  await view.press({ label: 'Details of db' })
  assert.equal(view.find({ text: 'Open shell' }), null)
  assert.ok(view.find({ text: 'Follow logs in terminal' }))
  await view.unmount()
})

test('avisa quando o terminal não pôde abrir', async () => {
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web], at: 1 }), {
      'containers.inspect': () => ({ ok: true, info }),
      'containers.terminal': () => ({ ok: false, code: 'no_workspace', error: 'Focus a workspace first' })
    })
  })
  await view.press({ label: 'Details of web' })
  await view.press({ text: 'Open shell' })
  assert.ok(shows(view, 'Focus a workspace first'))
  await view.unmount()
})

test('usa o intervalo das configurações sem quebrar com valor inválido', async () => {
  const view = await mount(panel, {
    host: mockHost({ settings: { pollSeconds: 'abc' as never }, requests: { 'containers.list': () => ({ ok: true, containers: [web], at: 1 }) } as never })
  })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('mostra estado em palavras só quando importa e o tempo de forma compacta', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [web, sick, crashed], at: 1 })) })
  assert.ok(shows(view, '· unhealthy'))
  assert.ok(shows(view, '· exited (3)'))
  assert.ok(shows(view, '· 1h ago'))
  assert.ok(shows(view, '· 2m'))
  assert.ok(shows(view, '●'))
  assert.ok(shows(view, '○'))
  assert.equal(shows(view, 'running'), false)
  assert.equal(shows(view, 'Up 2 minutes (unhealthy)'), false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('recolher o grupo esconde os containers e mantém as ações do projeto no cabeçalho', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [web, db, solo], at: 1 })) })
  assert.ok(shows(view, 'Stop web'))
  await view.press({ text: 'meu-app' })
  assert.equal(shows(view, 'Stop web'), false)
  assert.ok(shows(view, 'Restart all'))
  assert.ok(shows(view, 'Stop solo'))
  await view.press({ text: 'meu-app' })
  assert.ok(shows(view, 'Stop web'))
  await view.unmount()
})

test('o grupo de avulsos não tem ações de projeto', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [solo], at: 1 })) })
  assert.equal(shows(view, 'Stop all'), false)
  await view.unmount()
})

test('dentro do grupo, containers parados aparecem depois dos ativos', async () => {
  const view = await mount(panel, { host: hostWith(() => ({ ok: true, containers: [db, web, sick], at: 1 })) })
  const tree = JSON.stringify(view.tree())
  const at = (name: string) => tree.indexOf(JSON.stringify(`Details of ${name}`))
  assert.ok(at('api') !== -1 && at('web') !== -1 && at('db') !== -1)
  assert.ok(at('api') < at('web'))
  assert.ok(at('web') < at('db'))
  await view.unmount()
})

const usage = {
  [web.id.slice(0, 12)]: { cpu: 3.46, memBytes: 18.5 * 1024 ** 2, memLimit: 2 * 1024 ** 3, memPercent: 0.9 },
  [sick.id.slice(0, 12)]: { cpu: 120, memBytes: 1.9 * 1024 ** 3, memLimit: 2 * 1024 ** 3, memPercent: 95 }
}

test('mostra CPU e memória dos containers em execução e destaca memória no limite', async () => {
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web, sick, db], at: 1 }), { 'containers.stats': () => ({ ok: true, stats: usage }) })
  })
  assert.ok(shows(view, '· 3.5% CPU'))
  assert.ok(shows(view, '· 19 MB'))
  assert.ok(shows(view, '· 120% CPU'))
  assert.ok(shows(view, '· 1.9 GB (95%)'))
  assert.equal(shows(view, '(0.9%)'), false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('container parado não mostra consumo, mesmo com número antigo', async () => {
  const mixed = {
    [web.id.slice(0, 12)]: { cpu: 3.46, memBytes: 18.5 * 1024 ** 2, memLimit: 0, memPercent: 1 },
    [db.id.slice(0, 12)]: { cpu: 50, memBytes: 1024 ** 3, memLimit: 0, memPercent: 10 }
  }
  const view = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web, db], at: 1 }), { 'containers.stats': () => ({ ok: true, stats: mixed }) })
  })
  assert.ok(shows(view, '· 3.5% CPU'), 'os números do container rodando precisam ter chegado')
  assert.equal(shows(view, '· 50% CPU'), false)
  assert.equal(shows(view, '· 1 GB'), false)
  await view.unmount()
})

test('sem stats o painel segue normal, sem erro na tela', async () => {
  const failing = await mount(panel, {
    host: hostWith(() => ({ ok: true, containers: [web], at: 1 }), { 'containers.stats': () => ({ ok: false, error: 'boom' }) })
  })
  assert.equal(shows(failing, 'CPU'), false)
  assert.equal(shows(failing, 'boom'), false)
  assert.deepEqual(failing.errors, [])
  await failing.unmount()
})

test('a configuração showStats desliga a leitura', async () => {
  let calls = 0
  const view = await mount(panel, {
    host: mockHost({
      settings: { showStats: false as never },
      requests: { 'containers.list': () => ({ ok: true, containers: [web], at: 1 }), 'containers.stats': () => (calls++, { ok: true, stats: usage }) } as never
    })
  })
  assert.equal(calls, 0)
  assert.equal(shows(view, 'CPU'), false)
  await view.unmount()
})
