// Escuta `docker events`: avisa quando algum container muda e repassa cada evento relevante.
import { spawn, type ChildProcess } from 'node:child_process'
import { dockerArgs, dockerBinary } from './docker.ts'

const EVENTS = ['start', 'stop', 'die', 'oom', 'create', 'destroy', 'restart', 'pause', 'unpause', 'rename', 'health_status']
const DEBOUNCE_MS = 300
const RETRY_MS = 10_000

export type DockerEvent = {
  /** die, oom, start, "health_status: unhealthy"... */
  action: string
  id: string
  name: string
  project: string | null
  /** Só no `die`; null quando o Docker não informou. */
  exitCode: number | null
}

/** Uma linha de `docker events --format '{{json .}}'`. */
export function parseEvent(line: string): DockerEvent | null {
  let raw: any
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const action = typeof raw?.Action === 'string' ? raw.Action : ''
  if (!action) return null
  const attributes = (raw.Actor?.Attributes ?? {}) as Record<string, unknown>
  const code = typeof attributes.exitCode === 'string' ? Number(attributes.exitCode) : NaN
  const project = attributes['com.docker.compose.project']
  return {
    action,
    id: typeof raw.Actor?.ID === 'string' ? raw.Actor.ID : '',
    name: typeof attributes.name === 'string' ? attributes.name : '',
    project: typeof project === 'string' && project ? project : null,
    exitCode: Number.isFinite(code) ? code : null
  }
}

export type Watcher = { stop(): void }

export type WatchOptions = {
  /** Chamado uma vez por rajada de eventos (com debounce): hora de recarregar a lista. */
  onChange: () => void
  /** Chamado para cada evento, sem debounce. */
  onEvent?: (event: DockerEvent) => void
  log?: (message: string) => void
}

export function watchEvents({ onChange, onEvent, log = () => {} }: WatchOptions): Watcher {
  let child: ChildProcess | null = null
  let stopped = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let buffer = ''

  const ping = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(onChange, DEBOUNCE_MS)
  }

  const start = (): void => {
    if (stopped) return
    const args = dockerArgs([
      'events',
      '--filter',
      'type=container',
      ...EVENTS.flatMap((name) => ['--filter', `event=${name}`]),
      '--format',
      '{{json .}}'
    ])
    const proc = spawn(dockerBinary(), args, { stdio: ['ignore', 'pipe', 'ignore'] })
    child = proc
    buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEvent(line.trim())
        if (event) onEvent?.(event)
      }
      ping()
    })
    proc.on('error', (error) => log(`docker events: ${error.message}`))
    proc.on('close', () => {
      child = null
      // Docker parado ou ausente: tenta de novo depois, sem fazer barulho.
      if (!stopped) retry = setTimeout(start, RETRY_MS)
    })
  }

  start()
  return {
    stop() {
      stopped = true
      if (debounce) clearTimeout(debounce)
      if (retry) clearTimeout(retry)
      child?.kill()
    }
  }
}
