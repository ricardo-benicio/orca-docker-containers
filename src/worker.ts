// Worker do plugin: conversa com o Docker, vigia os eventos e cuida da barra de status e dos avisos.
// O Orca o mantém ligado enquanto o plugin estiver habilitado (por causa do item da barra de status).
import type { OrcaWorkerApi } from 'orca/worker'
import { alertFor, shouldSend } from './alerts'
import { composeCommand, forget, loadRefs, remember, sameRefs, type ComposeRef } from './compose'
import { DEFAULTS, normalizeConfig, type Config } from './config'
import {
  configureDocker,
  containerAction,
  containerStats,
  containerLogs,
  DockerError,
  followLogsCommand,
  inspectContainer,
  isValidAction,
  isValidId,
  isValidProject,
  type DetailedRow,
  listDetailed,
  projectAction,
  shellCommand
} from './docker'
import { watchEvents, type Watcher } from './events'
import { translate, type Key } from './i18n'
import type { ContainerRow } from './protocol'
import { pickWorkspace } from './workspace'

const STATUS_ID = 'docker-status'
const SAFETY_REFRESH_MS = 60_000

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Título de terminal seguro: sem caracteres de controle e com tamanho limitado. */
function cleanTitle(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : ''
  return text || fallback
}

let teardown: (() => void) | null = null
let makeWatcher: typeof watchEvents = watchEvents

/** Só para testes: troca a fábrica do monitor de eventos. Sem argumento, volta ao padrão. */
export function setWatcherFactory(factory?: typeof watchEvents): void {
  makeWatcher = factory ?? watchEvents
}

export function deactivate(): void {
  teardown?.()
  teardown = null
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let config: Config = DEFAULTS
  let watcher: Watcher | null = null
  let snapshot: ContainerRow[] = []
  let refs: ComposeRef[] = []
  const lastAlert = new Map<string, number>()
  // O worker não vê o idioma do Orca; o do sistema é a melhor aproximação para os avisos.
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  const t = (key: Key, vars?: Record<string, string | number>): string => translate(locale, key, vars)

  const loadConfig = async (): Promise<void> => {
    try {
      config = normalizeConfig((await orca.settings.get()) as Record<string, unknown>)
    } catch {
      config = DEFAULTS
    }
    configureDocker({ path: config.dockerPath, context: config.dockerContext })
  }

  const setStatusBar = async (fields: Record<string, unknown>): Promise<void> => {
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ID, ...fields } as never)
    } catch {
      // Orca antigo ou sem barra de status: o painel continua funcionando.
    }
  }

  const saveRefs = async (next: ComposeRef[]): Promise<void> => {
    const changed = !sameRefs(refs, next)
    refs = next
    if (!changed) return
    try {
      await orca.storage.set('composeProjects', next as never)
    } catch {
      // Sem armazenamento: o Up só fica disponível enquanto o projeto tiver containers.
    }
  }

  /** Guarda onde cada projeto Compose mora, para o Up continuar possível depois de um down. */
  const learn = async (found: DetailedRow[]): Promise<void> => {
    await saveRefs(remember(refs, found, Date.now()))
  }

  const refreshSnapshot = async (): Promise<void> => {
    try {
      const found = await listDetailed()
      snapshot = found.map((entry) => entry.row)
      void learn(found)
      if (!config.statusBar) return void (await setStatusBar({ visible: false }))
      const up = snapshot.filter((c) => c.state === 'running').length
      await setStatusBar({
        text: `${up}/${snapshot.length}`,
        tone: up > 0 ? 'success' : 'neutral',
        tooltip: t('statusTooltip', { up, total: snapshot.length }),
        visible: true
      })
    } catch (error) {
      snapshot = []
      if (!config.statusBar) return void (await setStatusBar({ visible: false }))
      await setStatusBar({ text: 'off', tone: 'warning', tooltip: `${t('statusOff')}: ${message(error)}`, visible: true })
    }
  }

  const notify = async (event: Parameters<NonNullable<Parameters<typeof watchEvents>[0]['onEvent']>>[0]): Promise<void> => {
    if (!config.notifications) return
    const alert = alertFor(event)
    if (!alert || !shouldSend(lastAlert, alert, Date.now())) return
    const where = alert.project ? ` (${alert.project})` : ''
    const key = alert.kind === 'crashed' ? 'Crashed' : alert.kind === 'oom' ? 'Oom' : 'Unhealthy'
    try {
      const result = await orca.host.call('notifications.show', {
        title: t(`notif${key}Title` as Key),
        body: t(`notif${key}Body` as Key, { name: alert.name, code: alert.exitCode ?? '' }) + where
      })
      orca.log(`notification ${alert.kind} for ${alert.name}: delivered=${String(result?.delivered)}`)
    } catch (error) {
      // Sem permissão de notificação: ignora, mas deixa rastro no log do plugin.
      orca.log(`notification ${alert.kind} for ${alert.name} failed: ${message(error)}`)
    }
  }

  const startWatcher = (): void => {
    watcher?.stop()
    watcher = makeWatcher({
      onChange: () => {
        orca.panels.post('containers.changed', { at: Date.now() })
        void refreshSnapshot()
      },
      onEvent: (event) => void notify(event),
      log: orca.log
    })
  }

  await loadConfig()
  try {
    refs = loadRefs(await orca.storage.get('composeProjects'))
  } catch {
    refs = []
  }
  startWatcher()
  void refreshSnapshot()
  const timer = setInterval(() => void refreshSnapshot(), SAFETY_REFRESH_MS)

  const settingsListener = orca.settings.onDidChange(() => {
    void loadConfig().then(() => {
      startWatcher()
      void refreshSnapshot()
      orca.panels.post('containers.changed', { at: Date.now() })
    })
  })

  teardown = () => {
    clearInterval(timer)
    watcher?.stop()
    watcher = null
    settingsListener.dispose()
  }

  orca.commands.register('docker.summary', async () => {
    await refreshSnapshot()
    if (snapshot.length === 0) return t('summaryEmpty')
    const up = snapshot.filter((c) => c.state === 'running').length
    const byProject = new Map<string, ContainerRow[]>()
    for (const row of snapshot) byProject.set(row.project ?? '—', [...(byProject.get(row.project ?? '—') ?? []), row])
    const lines = [...byProject].map(([name, rows]) => `${name}: ${rows.filter((c) => c.state === 'running').length}/${rows.length}`)
    return [t('summaryTitle', { up, total: snapshot.length }), ...lines].join('\n')
  })

  orca.panels.handle('containers.list', async (_input, { signal }) => {
    try {
      const found = await listDetailed(signal)
      const containers = found.map((entry) => entry.row)
      snapshot = containers
      void learn(found)
      return { ok: true as const, containers, at: Date.now() }
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

  orca.panels.handle('workspace.context', async () => {
    try {
      const context = await orca.host.call('workspace.readContext')
      if (!context) return { name: null, path: null }
      const { workspaces } = await orca.host.call('workspace.list')
      const found = pickWorkspace(context, workspaces)
      return { name: context.displayName || null, path: found?.path ?? null }
    } catch {
      // Sem permissão de leitura ou Orca antigo: o painel só não destaca o projeto.
      return { name: null, path: null }
    }
  })

  orca.panels.handle('containers.stats', async (_input, { signal }) => {
    try {
      return { ok: true as const, stats: await containerStats(signal) }
    } catch (error) {
      return { ok: false as const, error: message(error) }
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

  orca.panels.handle('containers.inspect', async (input, { signal }) => {
    if (!isValidId(input.id)) throw invalid('invalid container')
    try {
      return { ok: true as const, info: await inspectContainer(input.id, signal) }
    } catch (error) {
      return { ok: false as const, error: message(error) }
    }
  })

  /** Abre um terminal no workspace em foco rodando `command`. */
  const openTerminal = async (title: string, command: string) => {
    try {
      const context = await orca.host.call('workspace.readContext')
      if (!context?.workspaceId) return { ok: false, code: 'no_workspace' as const, error: t('noWorkspace') }
      await orca.host.call('terminal.create', { workspaceId: context.workspaceId, title, command })
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'failed' as const, error: message(error) }
    }
  }

  orca.panels.handle('containers.terminal', async (input) => {
    if (!isValidId(input.id) || (input.kind !== 'shell' && input.kind !== 'logs')) throw invalid('invalid container or terminal')
    const name = cleanTitle(input.name, input.id)
    return openTerminal(input.kind === 'shell' ? `shell · ${name}` : `logs · ${name}`, input.kind === 'shell' ? shellCommand(input.id) : followLogsCommand(input.id))
  })

  orca.panels.handle('compose.projects', async () => ({
    projects: refs.map((ref) => ({ project: ref.project, workingDir: ref.dir }))
  }))

  orca.panels.handle('compose.forget', async (input) => {
    if (!isValidProject(input.project)) throw invalid('invalid project')
    await saveRefs(forget(refs, input.project))
    return { ok: true }
  })

  orca.panels.handle('compose.run', async (input) => {
    if (!isValidProject(input.project) || (input.action !== 'up' && input.action !== 'down')) throw invalid('invalid project or action')
    const ref = refs.find((candidate) => candidate.project === input.project) ?? null
    const command = composeCommand(input.action, input.project, ref)
    if (!command) return { ok: false, code: 'no_files' as const, error: t('composeNoFiles') }
    return openTerminal(`compose ${input.action} · ${cleanTitle(input.project, input.project)}`, command)
  })
}
