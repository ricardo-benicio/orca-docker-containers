// Como cada container aparece na lista: cor do ponto, estado em texto curto e tempo compacto.
// Puro (sem Orca): roda nos testes do CI com node:test.
export type DotTone = 'neutral' | 'success' | 'warning' | 'danger'

/** Estado que merece palavra ao lado do nome; "running" saudável não precisa, o ponto verde diz tudo. */
export type StateWord = 'unhealthy' | 'starting' | 'restarting' | 'paused' | 'exited' | 'created' | 'dead'

export type Look = {
  tone: DotTone
  /** Círculo cheio para ativo, vazio para parado: não depende só de cor. */
  filled: boolean
  word: StateWord | null
  /** Código de saída, só quando o container terminou ou está reiniciando. */
  code: number | null
  /** Tempo compacto: "3h" em execução, "2w" desde que saiu. Vazio quando o docker não informa. */
  age: string
  /** Realça a linha inteira: algo que pede atenção agora. */
  problem: 'danger' | 'warning' | null
}

const UNITS: Record<string, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }

/** "Less than a second" -> "<1s", "About an hour" -> "1h", "3 days" -> "3d". Texto desconhecido passa como veio. */
export function compactDuration(text: string): string {
  const value = text.trim()
  if (value === 'Less than a second') return '<1s'
  if (value === 'About a minute') return '1m'
  if (value === 'About an hour') return '1h'
  const match = /^(\d+) (second|minute|hour|day|week|month|year)s?$/.exec(value)
  return match ? `${match[1]}${UNITS[match[2]!]}` : value
}

type Parsed = { kind: 'up' | 'exited' | 'restarting' | 'other'; age: string; code: number | null; paused: boolean; health: 'healthy' | 'unhealthy' | 'starting' | null }

function parseStatus(status: string): Parsed {
  const up = /^Up (.+?)(?: \((Paused)\))?(?: \((healthy|unhealthy|health: starting)\))?$/.exec(status)
  if (up) {
    const health = up[3] === 'healthy' ? 'healthy' : up[3] === 'unhealthy' ? 'unhealthy' : up[3] ? 'starting' : null
    return { kind: 'up', age: compactDuration(up[1]!), code: null, paused: up[2] === 'Paused', health }
  }
  const gone = /^(Exited|Restarting) \((-?\d+)\) (.+) ago$/.exec(status)
  if (gone) {
    return { kind: gone[1] === 'Exited' ? 'exited' : 'restarting', age: compactDuration(gone[3]!), code: Number(gone[2]), paused: false, health: null }
  }
  return { kind: 'other', age: '', code: null, paused: false, health: null }
}

/** Códigos que o `docker stop` produz (SIGKILL/SIGTERM) não são falha do container. */
const CLEAN_EXIT = new Set([0, 137, 143])

export function lookOf(row: { state: string; status: string }): Look {
  const parsed = parseStatus(row.status)
  const base = { code: parsed.code, age: parsed.age }
  switch (row.state) {
    case 'running':
      if (parsed.health === 'unhealthy') return { ...base, tone: 'danger', filled: true, word: 'unhealthy', problem: 'danger' }
      if (parsed.health === 'starting') return { ...base, tone: 'warning', filled: true, word: 'starting', problem: null }
      return { ...base, tone: 'success', filled: true, word: null, problem: null }
    case 'paused':
      return { ...base, tone: 'warning', filled: true, word: 'paused', problem: null }
    case 'restarting':
      return { ...base, tone: 'warning', filled: true, word: 'restarting', problem: 'warning' }
    case 'dead':
      return { ...base, tone: 'danger', filled: true, word: 'dead', problem: 'danger' }
    case 'exited':
      return { ...base, tone: parsed.code !== null && !CLEAN_EXIT.has(parsed.code) ? 'danger' : 'neutral', filled: false, word: 'exited', problem: null }
    default:
      return { ...base, tone: 'neutral', filled: false, word: row.state === 'created' ? 'created' : null, problem: null }
  }
}

/** Parado de verdade: não está rodando, pausado nem reiniciando. */
export function isStopped(state: string): boolean {
  return state !== 'running' && state !== 'paused' && state !== 'restarting'
}

/** Ativos primeiro, parados no fim; dentro de cada faixa, por nome, para a lista não pular entre atualizações. */
export function sortRows<T extends { state: string; name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(isStopped(a.state)) - Number(isStopped(b.state)) || a.name.localeCompare(b.name))
}

/** Memória como o Docker mostra (base 1024), curta: "512 KB", "18 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(bytes, 0)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** "0.1%", "3.4%", "87%", "240%". */
export function formatCpu(percent: number): string {
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`
}

export type Usage = { cpu: number; memPercent: number }

/** Realce do consumo: memória quase no limite é o que derruba container; CPU alta só avisa. */
export function memoryTone(usage: Usage): 'danger' | 'warning' | null {
  return usage.memPercent >= 90 ? 'danger' : usage.memPercent >= 75 ? 'warning' : null
}

export function cpuTone(usage: Usage): 'warning' | null {
  return usage.cpu >= 80 ? 'warning' : null
}
