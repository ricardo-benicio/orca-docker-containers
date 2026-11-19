// Funções puras e chamadas ao CLI do Docker. Sem shell: execFile com argumentos fixos.
import { execFile } from 'node:child_process'
import type { ContainerRow } from './protocol'

const ID_PATTERN = /^[a-f0-9]{12,64}$/
const ACTIONS = new Set(['start', 'stop', 'restart'])

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

export function isValidAction(action: unknown): action is 'start' | 'stop' | 'restart' {
  return typeof action === 'string' && ACTIONS.has(action)
}

/** "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp" vira ["5432→5432"]. */
export function parsePorts(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const match = /:(\d+)->(\d+)\/(?:tcp|udp)/.exec(part)
    if (match) seen.add(`${match[1]}→${match[2]}`)
  }
  return [...seen]
}

export function parseProject(labels: string): string | null {
  for (const pair of labels.split(',')) {
    if (pair.startsWith('com.docker.compose.project=')) {
      return pair.slice('com.docker.compose.project='.length) || null
    }
  }
  return null
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
    project: parseProject(text('Labels'))
  }
}

export function parseList(stdout: string): ContainerRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLine)
    .filter((row): row is ContainerRow => row !== null)
}

function run(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { maxBuffer: 4 * 1024 * 1024, timeout: 20_000, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

export async function listContainers(signal?: AbortSignal): Promise<ContainerRow[]> {
  const { stdout } = await run(['ps', '-a', '--format', '{{json .}}'], signal)
  return parseList(stdout)
}

export async function containerAction(
  id: string,
  action: 'start' | 'stop' | 'restart',
  signal?: AbortSignal
): Promise<void> {
  await run([action, id], signal)
}

export async function containerLogs(id: string, tail: number, signal?: AbortSignal): Promise<string> {
  // Os logs do docker saem em stdout e stderr; juntamos os dois.
  const { stdout, stderr } = await run(['logs', '--tail', String(tail), id], signal)
  return [stdout, stderr].filter(Boolean).join('')
}
