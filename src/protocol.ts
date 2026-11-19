// Contrato painel <-> worker, declarado uma vez: src/panel.tsx e src/worker.ts leem daqui.
export {}

export type PublishedPort = { host: number; container: number }

export type ContainerRow = {
  id: string
  name: string
  image: string
  /** running, exited, paused, restarting, created, dead */
  state: string
  /** Texto do docker, ex.: "Up 3 hours (healthy)". */
  status: string
  /** Portas publicadas no host. */
  ports: PublishedPort[]
  /** Projeto do Docker Compose; null quando o container é avulso. */
  project: string | null
}

export type DockerErrorCode = 'docker_missing' | 'daemon_down' | 'permission' | 'unknown'

export type ListResult =
  | { ok: true; containers: ContainerRow[]; at: number }
  | { ok: false; code: DockerErrorCode; error: string }

export type Action = 'start' | 'stop' | 'restart'

/** Detalhes de um container. Nunca inclui variáveis de ambiente nem labels, que podem ter segredos. */
export type ContainerInfo = {
  id: string
  name: string
  image: string
  created: string
  command: string
  restart: string
  networks: { name: string; ip: string }[]
  mounts: { type: string; source: string; destination: string; rw: boolean }[]
}

export type TerminalKind = 'shell' | 'logs'

declare module 'orca' {
  interface PluginRequests {
    /** Lista todos os containers (inclusive parados) e liga o monitor de eventos do Docker. */
    'containers.list': { output: ListResult }
    /** Inicia, para ou reinicia um container. */
    'containers.action': {
      input: { id: string; action: Action }
      output: { ok: boolean; error?: string }
    }
    /** Inicia, para ou reinicia todos os containers de um projeto Compose. */
    'project.action': {
      input: { project: string; action: Action }
      output: { ok: boolean; count: number; error?: string }
    }
    /** Rede, volumes, comando e política de restart de um container. */
    'containers.inspect': {
      input: { id: string }
      output: { ok: true; info: ContainerInfo } | { ok: false; error: string }
    }
    /** Abre um terminal do Orca no workspace em foco: shell dentro do container ou logs em tempo real. */
    'containers.terminal': {
      input: { id: string; kind: TerminalKind; name?: string }
      output: { ok: boolean; code?: 'no_workspace' | 'failed'; error?: string }
    }
    /** Últimas linhas de log de um container. */
    'containers.logs': {
      input: { id: string; tail?: number }
      output: { ok: boolean; text: string }
    }
  }
  interface PluginPanelEvents {
    /** O Docker informou que algum container mudou; o painel deve recarregar a lista. */
    'containers.changed': { at: number }
  }
}
