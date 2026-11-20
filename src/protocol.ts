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
  /** Pasta do projeto Compose no host (label `working_dir`), usada para achar o workspace dele. */
  workingDir?: string | null
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
  /** Limite de memória em bytes; 0 quando não há limite. */
  memoryLimit: number
  /** Diagnóstico: por que o container está assim. Só campos de estado, nunca ambiente nem labels. */
  state: ContainerState
}

export type ContainerState = {
  status: string
  exitCode: number
  oomKilled: boolean
  /** Erro de execução relatado pelo Docker (ex.: comando não encontrado). Texto curto, sem controle. */
  error: string
  startedAt: string
  finishedAt: string
  restartCount: number
  health: { status: string; failingStreak: number; lastOutput: string } | null
}

/** Workspace em foco no Orca e a pasta dele, para destacar o projeto Compose que mora lá. */
export type WorkspaceContext = { name: string | null; path: string | null }

/** Uso de recursos de um container em execução, lido de `docker stats --no-stream`. */
export type ContainerStats = {
  /** Percentual de CPU; passa de 100 quando usa mais de um núcleo. */
  cpu: number
  memBytes: number
  /** Limite de memória do container (ou da máquina, quando não há limite). 0 quando desconhecido. */
  memLimit: number
  memPercent: number
}

export type StatsResult = { ok: true; stats: Record<string, ContainerStats> } | { ok: false; error: string }

export type ComposeAction = 'up' | 'down'

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
    /** Projetos Compose que o plugin já viu, para oferecer o Up mesmo depois de um down. */
    'compose.projects': { output: { projects: { project: string; workingDir: string }[] } }
    /** Esquece um projeto lembrado. */
    'compose.forget': { input: { project: string }; output: { ok: boolean } }
    /** Abre um terminal do Orca rodando `docker compose up -d` ou `down` para o projeto. */
    'compose.run': {
      input: { project: string; action: ComposeAction }
      output: { ok: boolean; code?: 'no_workspace' | 'no_files' | 'failed'; error?: string }
    }
    /** Nome e pasta do workspace em foco no Orca; vazios quando nenhum está em foco. */
    'workspace.context': { output: WorkspaceContext }
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
    /** CPU e memória dos containers em execução, por id curto (12 caracteres). */
    'containers.stats': { output: StatsResult }
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
