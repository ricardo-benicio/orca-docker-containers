// Worker do plugin: conversa com o Docker. O Orca o inicia no primeiro plugin.request do painel.
import type { OrcaWorkerApi } from 'orca/worker'
import { containerAction, containerLogs, isValidAction, isValidId, listContainers } from './docker'

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('containers.list', async (_input, { signal }) => {
    try {
      return { ok: true as const, containers: await listContainers(signal), at: Date.now() }
    } catch (error) {
      return { ok: false as const, error: message(error) }
    }
  })

  orca.panels.handle('containers.action', async (input, { signal }) => {
    if (!isValidId(input.id) || !isValidAction(input.action)) throw invalid('container ou ação inválidos')
    try {
      await containerAction(input.id, input.action, signal)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })

  orca.panels.handle('containers.logs', async (input, { signal }) => {
    if (!isValidId(input.id)) throw invalid('container inválido')
    const tail = Math.min(Math.max(Math.trunc(input.tail ?? 200), 1), 1000)
    try {
      return { ok: true, text: await containerLogs(input.id, tail, signal) }
    } catch (error) {
      return { ok: false, text: message(error) }
    }
  })
}
