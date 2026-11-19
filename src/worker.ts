// Worker do plugin: conversa com o Docker. O Orca o inicia no primeiro plugin.request do painel.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  containerAction,
  containerLogs,
  DockerError,
  isValidAction,
  isValidId,
  isValidProject,
  listContainers,
  projectAction
} from './docker'
import { watchEvents, type Watcher } from './events'

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let watcher: Watcher | null = null
let makeWatcher: typeof watchEvents = watchEvents

/** Só para testes: troca a fábrica do monitor de eventos. Sem argumento, volta ao padrão. */
export function setWatcherFactory(factory?: typeof watchEvents): void {
  makeWatcher = factory ?? watchEvents
}

export function deactivate(): void {
  watcher?.stop()
  watcher = null
}

export default function activate(orca: OrcaWorkerApi): void {
  // O monitor liga na primeira listagem e avisa os painéis abertos a cada mudança.
  const ensureWatcher = (): void => {
    watcher ??= makeWatcher(() => orca.panels.post('containers.changed', { at: Date.now() }), orca.log)
  }

  orca.panels.handle('containers.list', async (_input, { signal }) => {
    ensureWatcher()
    try {
      return { ok: true as const, containers: await listContainers(signal), at: Date.now() }
    } catch (error) {
      const code = error instanceof DockerError ? error.code : ('unknown' as const)
      return { ok: false as const, code, error: message(error) }
    }
  })

  orca.panels.handle('containers.action', async (input, { signal }) => {
    if (!isValidId(input.id) || !isValidAction(input.action)) throw invalid('invalid container or action')
    try {
      await containerAction(input.id, input.action, signal)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })

  orca.panels.handle('project.action', async (input, { signal }) => {
    if (!isValidProject(input.project) || !isValidAction(input.action)) throw invalid('invalid project or action')
    try {
      return { ok: true, count: await projectAction(input.project, input.action, signal) }
    } catch (error) {
      return { ok: false, count: 0, error: message(error) }
    }
  })

  orca.panels.handle('containers.logs', async (input, { signal }) => {
    if (!isValidId(input.id)) throw invalid('invalid container')
    const tail = Math.min(Math.max(Math.trunc(input.tail ?? 200), 1), 1000)
    try {
      return { ok: true, text: await containerLogs(input.id, tail, signal) }
    } catch (error) {
      return { ok: false, text: message(error) }
    }
  })
}
