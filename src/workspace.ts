// Casa um projeto do Docker Compose com o workspace em foco do Orca. Puro: roda no CI com node:test.
export type WorkspaceRow = { id: string; name: string; path: string; branch: string | null; hostId: string | null }
export type FocusContext = { workspaceId?: string; branch: string; displayName: string }

/** Caminho comparável: barras normais, sem barra final. */
export function normalizePath(path: string): string {
  const unified = path.trim().replace(/\\/g, '/')
  return unified.length > 1 ? unified.replace(/\/+$/, '') : unified
}

/** `dir` é a própria pasta `root` ou está dentro dela. Nunca casa só por prefixo de nome ("/a/app" vs "/a/app2"). */
export function isInside(dir: string | null | undefined, root: string | null | undefined): boolean {
  if (!dir || !root) return false
  const d = normalizePath(dir)
  const r = normalizePath(root)
  if (!d || !r || r === '/') return false
  return d === r || d.startsWith(`${r}/`)
}

/**
 * O workspace da lista que corresponde ao que está em foco: pelo id e, se o Orca usar ids
 * diferentes nas duas respostas, pelo nome + branch, desde que isso aponte um só. Só os locais:
 * o Docker consultado roda nesta máquina, e o caminho de um workspace SSH não existe aqui.
 */
export function pickWorkspace(context: FocusContext | null, rows: readonly WorkspaceRow[]): WorkspaceRow | null {
  if (!context) return null
  const local = rows.filter((row) => row.hostId === null || row.hostId === 'local')
  const byId = context.workspaceId ? local.find((row) => row.id === context.workspaceId) : undefined
  if (byId) return byId
  const same = local.filter((row) => row.name === context.displayName && (row.branch ?? '') === context.branch)
  return same.length === 1 ? same[0]! : null
}
