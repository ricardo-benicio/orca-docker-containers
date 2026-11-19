// Roda activate(orca) de src/worker.ts com o `orca` que o Orca entrega, sobre um host de mentira.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { setRunner } from './docker.ts'
import * as main from './worker'

const ID = 'abc123def456'
const row = JSON.stringify({ ID, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 1 hour', Ports: '0.0.0.0:8080->80/tcp', Labels: 'com.docker.compose.project=meu-app' })

function fakeDocker(calls: string[][], failWith?: Error) {
  setRunner(async (args) => {
    calls.push(args)
    if (failWith) throw failWith
    if (args[0] === 'ps' && args.includes('-q')) return `${ID}\n`
    if (args[0] === 'ps') return `${row}\n`
    if (args[0] === 'logs') return 'linha 1\nlinha 2\n'
    return ''
  })
}

test('lista, liga o monitor de eventos uma vez e avisa os painéis quando o docker muda', async () => {
  fakeDocker([])
  let started = 0
  let notify = () => {}
  main.setWatcherFactory((onChange) => {
    started += 1
    notify = onChange
    return { stop() {} }
  })
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    const first = await worker.request('containers.list')
    assert.equal(first.ok, true)
    if (first.ok) assert.deepEqual(first.containers[0]?.ports, [{ host: 8080, container: 80 }])
    await worker.request('containers.list')
    assert.equal(started, 1)
    notify()
    assert.equal(worker.posts.at(-1)?.event, 'containers.changed')
  } finally {
    await worker.deactivate()
    main.setWatcherFactory()
    setRunner()
  }
})

test('devolve o código do erro quando o docker não está disponível', async () => {
  const { DockerError } = await import('./docker.ts')
  fakeDocker([], new DockerError('daemon_down', 'Cannot connect to the Docker daemon'))
  main.setWatcherFactory(() => ({ stop() {} }))
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    const result = await worker.request('containers.list')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'daemon_down')
  } finally {
    await worker.deactivate()
    main.setWatcherFactory()
    setRunner()
  }
})

test('ações em container e em projeto, e logs, chamam o docker certo', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    assert.deepEqual(await worker.request('containers.action', { id: ID, action: 'stop' }), { ok: true })
    assert.deepEqual(calls.at(-1), ['stop', ID])
    assert.deepEqual(await worker.request('project.action', { project: 'meu-app', action: 'restart' }), { ok: true, count: 1 })
    assert.deepEqual(calls.at(-1), ['restart', ID])
    const logs = await worker.request('containers.logs', { id: ID, tail: 5000 })
    assert.equal(logs.ok, true)
    assert.deepEqual(calls.at(-1), ['logs', '--tail', '1000', ID])
  } finally {
    await worker.deactivate()
    setRunner()
  }
})

test('recusa ids, projetos e ações inválidos sem chamar o docker', async () => {
  const calls: string[][] = []
  fakeDocker(calls)
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    await assert.rejects(worker.request('containers.action', { id: '--all', action: 'stop' }))
    await assert.rejects(worker.request('containers.action', { id: ID, action: 'rm' as 'stop' }))
    await assert.rejects(worker.request('project.action', { project: '--all', action: 'stop' }))
    await assert.rejects(worker.request('containers.logs', { id: '--all' }))
    assert.deepEqual(calls, [])
  } finally {
    await worker.deactivate()
    setRunner()
  }
})
