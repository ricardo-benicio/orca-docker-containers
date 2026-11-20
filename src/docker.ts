// Funções puras e chamadas ao CLI do Docker. Sem shell: execFile com argumentos fixos.
import { execFile } from 'node:child_process'
import { DEFAULTS, isSafeContext, isSafePath } from './config.ts'
import type { Action, ContainerInfo, ContainerRow, ContainerStats, DockerErrorCode, PublishedPort } from './protocol'

const ID_PATTERN = /^[a-f0-9]{12,64}$/
const PROJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const ACTIONS = new Set(['start', 'stop', 'restart'])
const PROJECT_LABEL = 'com.docker.compose.project'
const WORKDIR_LABEL = 'com.docker.compose.project.working_dir'
const FILES_LABEL = 'com.docker.compose.project.config_files'
const ENVFILE_LABEL = 'com.docker.compose.project.environment_file'

export class DockerError extends Error {
  readonly code: DockerErrorCode
  constructor(code: DockerErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

export function isValidProject(project: unknown): project is string {
  return typeof project === 'string' && PROJECT_PATTERN.test(project)
}

export function isValidAction(action: unknown): action is Action {
  return typeof action === 'string' && ACTIONS.has(action)
}

/** "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp" vira [{ host: 5432, container: 5432 }]. */
export function parsePorts(raw: string): PublishedPort[] {
  const seen = new Map<string, PublishedPort>()
  for (const part of raw.split(',')) {
    const match = /:(\d+)->(\d+)\/(?:tcp|udp)/.exec(part)
    if (!match) continue
    const port = { host: Number(match[1]), container: Number(match[2]) }
    seen.set(`${port.host}:${port.container}`, port)
  }
  return [...seen.values()]
}

export function parseProject(labels: string): string | null {
  for (const pair of labels.split(',')) {
    if (pair.startsWith(`${PROJECT_LABEL}=`)) return pair.slice(PROJECT_LABEL.length + 1) || null
  }
  return null
}

/** Pasta do projeto Compose nos labels; um caminho com vírgula é cortado e simplesmente não casa. */
export function parseWorkingDir(labels: string): string | null {
  for (const pair of labels.split(',')) {
    if (pair.startsWith(`${WORKDIR_LABEL}=`)) return pair.slice(WORKDIR_LABEL.length + 1) || null
  }
  return null
}

/**
 * Valor de um label cujo conteúdo pode ter vírgulas (lista de arquivos): vai até o próximo
 * `chave=` ou o fim. Um caminho nunca começa como `chave=`, então a emenda é segura.
 */
function labelList(labels: string, key: string): string[] {
  const at = labels.startsWith(`${key}=`) ? 0 : labels.indexOf(`,${key}=`) + 1
  if (at === 0 && !labels.startsWith(`${key}=`)) return []
  const rest = labels.slice(at + key.length + 1)
  const end = rest.search(/,[a-zA-Z0-9][\w.-]*=/)
  return (end === -1 ? rest : rest.slice(0, end)).split(',').map((v) => v.trim()).filter(Boolean)
}

export type ComposeLabels = { dir: string | null; files: string[]; envFiles: string[] }

/** Onde o projeto Compose mora e quais arquivos o subiram, como o Docker gravou nos labels. */
export function parseComposeLabels(labels: string): ComposeLabels {
  return { dir: parseWorkingDir(labels), files: labelList(labels, FILES_LABEL), envFiles: labelList(labels, ENVFILE_LABEL) }
}

export function parseLine(line: string): ContainerRow | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const id = text('ID')
  if (!id) return null
  return {
    id,
    name: text('Names').split(',')[0] ?? id,
    image: text('Image'),
    state: text('State') || 'unknown',
    status: text('Status'),
    ports: parsePorts(text('Ports')),
    project: parseProject(text('Labels')),
    workingDir: parseWorkingDir(text('Labels'))
  }
}

export type DetailedRow = { row: ContainerRow; compose: ComposeLabels }

/** Como `parseList`, mas guarda também os labels do Compose, que ficam no worker e não vão para o painel. */
export function parseDetailed(stdout: string): DetailedRow[] {
  const out: DetailedRow[] = []
  for (const line of stdout.split('\n')) {
    const row = parseLine(line.trim())
    if (!row) continue
    let labels = ''
    try {
      const raw = JSON.parse(line.trim()) as Record<string, unknown>
      labels = typeof raw.Labels === 'string' ? raw.Labels : ''
    } catch {
      // parseLine já recusou a linha acima.
    }
    out.push({ row, compose: parseComposeLabels(labels) })
  }
  return out
}

export function parseList(stdout: string): ContainerRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLine)
    .filter((row): row is ContainerRow => row !== null)
}

/** Traduz a falha do CLI numa categoria que o painel sabe explicar. */
export function classifyError(code: unknown, stderr: string): DockerErrorCode {
  if (code === 'ENOENT') return 'docker_missing'
  const text = stderr.toLowerCase()
  if (text.includes('permission denied')) return 'permission'
  if (text.includes('cannot connect to the docker daemon') || text.includes('is the docker daemon running')) {
    return 'daemon_down'
  }
  return 'unknown'
}

let bin = DEFAULTS.dockerPath
let context = DEFAULTS.dockerContext

/** Aplica o binário e o contexto das configurações; valores inseguros voltam ao padrão. */
export function configureDocker(options: { path: string; context: string }): void {
  bin = isSafePath(options.path) ? options.path : DEFAULTS.dockerPath
  context = options.context && isSafeContext(options.context) ? options.context : ''
}

export function dockerBinary(): string {
  return bin
}

/** Argumentos reais da chamada, com `--context` quando configurado. */
export function dockerArgs(args: string[]): string[] {
  return context ? ['--context', context, ...args] : args
}

/** Linha de comando para colar num terminal. O binário e o contexto já são validados; os ids são hex. */
export function dockerCommandLine(args: string[]): string {
  return [bin, ...dockerArgs(args)].join(' ')
}

export function shellCommand(id: string): string {
  return dockerCommandLine(['exec', '-it', id, 'sh', '-c', "'command -v bash >/dev/null 2>&1 && exec bash || exec sh'"])
}

export function followLogsCommand(id: string): string {
  return dockerCommandLine(['logs', '-f', '--tail', '200', id])
}

export type Runner = (args: string[], signal?: AbortSignal) => Promise<string>

const defaultRunner: Runner = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(bin, dockerArgs(args), { maxBuffer: 4 * 1024 * 1024, timeout: 20_000, signal }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message
        reject(new DockerError(classifyError((error as NodeJS.ErrnoException).code, detail), detail))
        return
      }
      resolve([stdout, stderr].filter(Boolean).join(''))
    })
  })

let runner: Runner = defaultRunner

/** Só para testes: troca o executor do CLI. Sem argumento, volta ao padrão. */
export function setRunner(next?: Runner): void {
  runner = next ?? defaultRunner
}

export async function listContainers(signal?: AbortSignal): Promise<ContainerRow[]> {
  return parseList(await runner(['ps', '-a', '--format', '{{json .}}'], signal))
}

export async function listDetailed(signal?: AbortSignal): Promise<DetailedRow[]> {
  return parseDetailed(await runner(['ps', '-a', '--format', '{{json .}}'], signal))
}

export async function containerAction(id: string, action: Action, signal?: AbortSignal): Promise<void> {
  await runner([action, id], signal)
}

/** Aplica a ação a todos os containers do projeto e devolve quantos foram alvo. */
export async function projectAction(project: string, action: Action, signal?: AbortSignal): Promise<number> {
  const out = await runner(
    ['ps', '-a', '-q', '--no-trunc', '--filter', `label=${PROJECT_LABEL}=${project}`],
    signal
  )
  const ids = out.split('\n').map((s) => s.trim()).filter(isValidId)
  if (ids.length === 0) return 0
  await runner([action, ...ids], signal)
  return ids.length
}

export async function containerLogs(id: string, tail: number, signal?: AbortSignal): Promise<string> {
  return runner(['logs', '--tail', String(tail), id], signal)
}

/** Lê só os campos seguros de `docker inspect`; o resto (env, labels) nunca sai do worker. */
export function parseInspect(stdout: string): ContainerInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const raw = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any> | undefined
  if (!raw || typeof raw.Id !== 'string') return null
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const networks = Object.entries((raw.NetworkSettings?.Networks ?? {}) as Record<string, any>).map(([name, net]) => ({
    name,
    ip: text(net?.IPAddress)
  }))
  const mounts = (Array.isArray(raw.Mounts) ? raw.Mounts : []).map((m: Record<string, unknown>) => ({
    type: text(m.Type),
    source: text(m.Name) || text(m.Source),
    destination: text(m.Destination),
    rw: m.RW !== false
  }))
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const brief = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : ''
  const rawState = (raw.State ?? {}) as Record<string, any>
  const checks = Array.isArray(rawState.Health?.Log) ? rawState.Health.Log : []
  const state = {
    status: text(rawState.Status),
    exitCode: num(rawState.ExitCode),
    oomKilled: rawState.OOMKilled === true,
    error: brief(rawState.Error, 300),
    startedAt: text(rawState.StartedAt),
    finishedAt: text(rawState.FinishedAt),
    restartCount: num(raw.RestartCount),
    health: rawState.Health
      ? {
          status: text(rawState.Health.Status),
          failingStreak: num(rawState.Health.FailingStreak),
          lastOutput: brief(checks.at(-1)?.Output, 300)
        }
      : null
  }
  const args = Array.isArray(raw.Args) ? raw.Args.filter((a: unknown) => typeof a === 'string') : []
  return {
    id: raw.Id.slice(0, 12),
    name: text(raw.Name).replace(/^\//, ''),
    image: text(raw.Config?.Image),
    created: text(raw.Created),
    // Só o executável e os argumentos que a imagem declarou: nada de ambiente.
    command: [text(raw.Path), ...args].filter(Boolean).join(' '),
    restart: text(raw.HostConfig?.RestartPolicy?.Name) || 'no',
    networks,
    mounts,
    memoryLimit: num(raw.HostConfig?.Memory),
    state
  }
}

export async function inspectContainer(id: string, signal?: AbortSignal): Promise<ContainerInfo> {
  const info = parseInspect(await runner(['inspect', id], signal))
  if (!info) throw new DockerError('unknown', 'could not read docker inspect output')
  return info
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4
}

/** "18.5MiB" vira bytes; "--" ou texto estranho vira null. */
export function parseSize(text: string): number | null {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(text.trim())
  const unit = match ? SIZE_UNITS[match[2]!.toLowerCase()] : undefined
  if (!match || unit === undefined) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value * unit) : null
}

function parsePercent(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const match = /^([\d.]+)%$/.exec(text.trim())
  return match ? Number(match[1]) : null
}

/** Uma linha de `docker stats --format '{{json .}}'`; linhas sem dados (`--`) são ignoradas. */
export function parseStats(stdout: string): Record<string, ContainerStats> {
  const result: Record<string, ContainerStats> = {}
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const id = typeof raw.ID === 'string' ? raw.ID : ''
    const cpu = parsePercent(raw.CPUPerc)
    const [used, limit] = typeof raw.MemUsage === 'string' ? raw.MemUsage.split('/') : []
    const memBytes = used === undefined ? null : parseSize(used)
    if (!isValidId(id) || cpu === null || memBytes === null) continue
    result[id] = { cpu, memBytes, memLimit: (limit === undefined ? null : parseSize(limit)) ?? 0, memPercent: parsePercent(raw.MemPerc) ?? 0 }
  }
  return result
}

/** Uma leitura (`--no-stream`) de todos os containers em execução. */
export async function containerStats(signal?: AbortSignal): Promise<Record<string, ContainerStats>> {
  return parseStats(await runner(['stats', '--no-stream', '--format', '{{json .}}'], signal))
}
