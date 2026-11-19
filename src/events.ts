// Escuta `docker events` e avisa quando algum container muda, sem polling.
import { spawn, type ChildProcess } from 'node:child_process'

const EVENTS = ['start', 'stop', 'die', 'create', 'destroy', 'restart', 'pause', 'unpause', 'rename', 'health_status']
const DEBOUNCE_MS = 300
const RETRY_MS = 10_000

const ARGS = [
  'events',
  '--filter',
  'type=container',
  ...EVENTS.flatMap((name) => ['--filter', `event=${name}`]),
  '--format',
  '{{.Action}}'
]

export type Watcher = { stop(): void }

export function watchEvents(onChange: () => void, log: (message: string) => void = () => {}): Watcher {
  let child: ChildProcess | null = null
  let stopped = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const ping = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(onChange, DEBOUNCE_MS)
  }

  const start = (): void => {
    if (stopped) return
    const proc = spawn('docker', ARGS, { stdio: ['ignore', 'pipe', 'ignore'] })
    child = proc
    proc.stdout?.on('data', ping)
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
