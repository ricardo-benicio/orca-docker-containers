// `orca plugin test .` roda isto em Node com o mesmo runtime e as mesmas checagens do Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ContainerRow, ListResult } from './protocol'

const web: ContainerRow = { id: 'a'.repeat(12), name: 'web', image: 'nginx', state: 'running', status: 'Up 1 hour', ports: [{ host: 8080, container: 80 }], project: 'meu-app' }
const db: ContainerRow = { id: 'b'.repeat(12), name: 'db', image: 'postgres:16', state: 'exited', status: 'Exited (0) 2 days ago', ports: [], project: 'meu-app' }
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
  assert.ok(shows(view, 'meu-app (1/2)'))
  assert.ok(shows(view, 'Standalone (1/1)'))
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
  assert.ok(shows(view, 'meu-app (1/1)'))
  containers = [web, db]
  await view.post('containers.changed', { at: 2 })
  assert.ok(shows(view, 'meu-app (1/2)'))
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
