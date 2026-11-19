// Configurações do plugin (Settings → Plugins), validadas antes de qualquer uso.
export type Config = {
  /** Caminho ou nome do binário do Docker. */
  dockerPath: string
  /** Contexto do Docker (`docker context ls`); vazio usa o contexto atual. */
  dockerContext: string
  /** Intervalo do refresh de segurança do painel, em segundos. */
  pollSeconds: number
  /** Avisar quando um container cai, sofre OOM ou fica unhealthy. */
  notifications: boolean
  /** Mostrar o contador na barra de status. */
  statusBar: boolean
}

export const DEFAULTS: Config = {
  dockerPath: 'docker',
  dockerContext: '',
  pollSeconds: 30,
  notifications: true,
  statusBar: true
}

// Esses dois valores podem acabar numa linha de comando de terminal: só caracteres seguros.
const PATH_PATTERN = /^[\w./+@-]{1,200}$/
const CONTEXT_PATTERN = /^[a-zA-Z0-9][\w.-]{0,63}$/

export function isSafePath(value: unknown): value is string {
  return typeof value === 'string' && PATH_PATTERN.test(value)
}

export function isSafeContext(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_PATTERN.test(value)
}

export function normalizeConfig(raw: Record<string, unknown> | undefined): Config {
  const source = raw ?? {}
  const poll = typeof source.pollSeconds === 'number' && Number.isFinite(source.pollSeconds) ? source.pollSeconds : DEFAULTS.pollSeconds
  const context = typeof source.dockerContext === 'string' ? source.dockerContext.trim() : ''
  return {
    dockerPath: isSafePath(source.dockerPath) ? source.dockerPath : DEFAULTS.dockerPath,
    dockerContext: isSafeContext(context) ? context : DEFAULTS.dockerContext,
    pollSeconds: Math.min(Math.max(Math.round(poll), 10), 300),
    notifications: typeof source.notifications === 'boolean' ? source.notifications : DEFAULTS.notifications,
    statusBar: typeof source.statusBar === 'boolean' ? source.statusBar : DEFAULTS.statusBar
  }
}
