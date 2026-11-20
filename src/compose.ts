// Lembrar onde cada projeto Compose mora e montar os comandos `docker compose up|down` que vão
// para um terminal. Puro (sem Orca nem Docker): roda no CI com node:test.
//
// Os caminhos vêm de labels que o Docker gravou nos containers e do storage do plugin, ou seja,
// são dados de fora. Antes de virar linha de terminal passam por `isSafeLocalPath` e vão entre
// aspas simples, o que não deixa nada ser interpretado como comando.
import { dockerCommandLine } from './docker.ts'
import type { DetailedRow } from './docker.ts'
import type { ComposeAction } from './protocol'

export type ComposeRef = {
  project: string
  dir: string
  files: string[]
  envFiles: string[]
  /** Quando foi visto por último com containers, em ms; ordena e limita a lista. */
  seenAt: number
}

const MAX_PROJECTS = 30
const MAX_FILES = 20
const PROJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** Caminho absoluto, curto, sem caractere de controle nem aspa simples: pode ir entre aspas simples. */
export function isSafeLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false
  if (/[\u0000-\u001f\u007f']/.test(value)) return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

/** Só aceita o que `isSafeLocalPath` aceita e descarta o resto; um registro sem pasta ou arquivo não serve. */
export function toRef(input: unknown): ComposeRef | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const list = (value: unknown, max: number): string[] | null => {
    if (!Array.isArray(value) || value.length > max) return null
    return value.every(isSafeLocalPath) ? (value as string[]) : null
  }
  const files = list(raw.files, MAX_FILES)
  const envFiles = raw.envFiles === undefined ? [] : list(raw.envFiles, 5)
  if (typeof raw.project !== 'string' || !PROJECT_PATTERN.test(raw.project)) return null
  if (!isSafeLocalPath(raw.dir) || !files || files.length === 0 || !envFiles) return null
  return { project: raw.project, dir: raw.dir, files, envFiles, seenAt: typeof raw.seenAt === 'number' && Number.isFinite(raw.seenAt) ? raw.seenAt : 0 }
}

/** O que está guardado, já limpo: registros inválidos ou adulterados somem. */
export function loadRefs(stored: unknown): ComposeRef[] {
  if (!Array.isArray(stored)) return []
  return stored.map(toRef).filter((ref): ref is ComposeRef => ref !== null)
}

/** Junta o que a lista atual mostra ao que já se sabia: o mais recente vence, os mais antigos saem. */
export function remember(known: readonly ComposeRef[], rows: readonly DetailedRow[], now: number): ComposeRef[] {
  const byProject = new Map(known.map((ref) => [ref.project, ref]))
  for (const { row, compose } of rows) {
    if (!row.project || !compose.dir) continue
    const ref = toRef({ project: row.project, dir: compose.dir, files: compose.files, envFiles: compose.envFiles, seenAt: now })
    if (ref) byProject.set(ref.project, ref)
  }
  return [...byProject.values()].sort((a, b) => b.seenAt - a.seenAt || a.project.localeCompare(b.project)).slice(0, MAX_PROJECTS)
}

export function forget(known: readonly ComposeRef[], project: string): ComposeRef[] {
  return known.filter((ref) => ref.project !== project)
}

/** Mesma lista, para saber se mudou antes de gravar no storage. */
export function sameRefs(a: readonly ComposeRef[], b: readonly ComposeRef[]): boolean {
  const key = (refs: readonly ComposeRef[]) => JSON.stringify(refs.map((ref) => [ref.project, ref.dir, ref.files, ref.envFiles]))
  return key(a) === key(b)
}

function quote(value: string): string {
  return `'${value}'`
}

/**
 * Linha de comando para colar no terminal. `up` usa os arquivos que o Docker guardou; `down` só
 * precisa do nome do projeto e não leva `-v`, então volumes e imagens ficam.
 */
export function composeCommand(action: ComposeAction, project: string, ref: ComposeRef | null): string | null {
  if (!PROJECT_PATTERN.test(project)) return null
  if (action === 'down') return dockerCommandLine(['compose', '-p', quote(project), 'down'])
  if (!ref || ref.project !== project || !toRef(ref)) return null
  return dockerCommandLine([
    'compose',
    '-p',
    quote(project),
    '--project-directory',
    quote(ref.dir),
    ...ref.files.flatMap((file) => ['-f', quote(file)]),
    ...ref.envFiles.flatMap((file) => ['--env-file', quote(file)]),
    'up',
    '-d'
  ])
}
