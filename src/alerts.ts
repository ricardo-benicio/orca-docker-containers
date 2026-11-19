// Decide quando um evento do Docker merece uma notificação (e evita repetir a mesma).
import type { DockerEvent } from './events.ts'

export type Alert = {
  kind: 'crashed' | 'oom' | 'unhealthy'
  name: string
  project: string | null
  exitCode: number | null
}

/** Saídas que são parada normal: 0 (limpa), 137 (SIGKILL do `docker stop`) e 143 (SIGTERM). */
const NORMAL_EXIT = new Set([0, 137, 143])
const DEDUPE_MS = 60_000

export function alertFor(event: DockerEvent): Alert | null {
  const base = { name: event.name || event.id.slice(0, 12), project: event.project, exitCode: event.exitCode }
  if (event.action === 'die' && event.exitCode !== null && !NORMAL_EXIT.has(event.exitCode)) {
    return { kind: 'crashed', ...base }
  }
  if (event.action === 'oom') return { kind: 'oom', ...base }
  if (event.action === 'health_status: unhealthy') return { kind: 'unhealthy', ...base }
  return null
}

/** True na primeira vez que o par (container, tipo) aparece dentro da janela; registra o envio. */
export function shouldSend(last: Map<string, number>, alert: Alert, now: number): boolean {
  const key = `${alert.name}:${alert.kind}`
  const previous = last.get(key)
  if (previous !== undefined && now - previous < DEDUPE_MS) return false
  last.set(key, now)
  return true
}
