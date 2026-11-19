// Contrato painel <-> worker, declarado uma vez: src/panel.tsx e src/worker.ts leem daqui.
export {}

export type ContainerRow = {
  id: string
  name: string
  image: string
  /** running, exited, paused, restarting, created, dead */
  state: string
  /** Texto do docker, ex.: "Up 3 hours (healthy)". */
  status: string
  /** Portas publicadas, ex.: "5432→5432". */
  ports: string[]
  /** Projeto do Docker Compose; null quando o container é avulso. */
  project: string | null
}

export type ListResult =
  | { ok: true; containers: ContainerRow[]; at: number }
  | { ok: false; error: string }

declare module 'orca' {
  interface PluginRequests {
    /** Lista todos os containers (inclusive parados). */
    'containers.list': { output: ListResult }
    /** Inicia, para ou reinicia um container. */
    'containers.action': {
      input: { id: string; action: 'start' | 'stop' | 'restart' }
      output: { ok: boolean; error?: string }
    }
    /** Últimas linhas de log de um container. */
    'containers.logs': {
      input: { id: string; tail?: number }
      output: { ok: boolean; text: string }
    }
  }
}
