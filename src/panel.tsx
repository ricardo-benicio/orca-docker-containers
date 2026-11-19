// Sem build: o Orca remove os tipos e compila o JSX quando o painel carrega.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Switch,
  Text,
  update,
  type PanelContext,
  type Tone
} from 'orca'
import type { ContainerRow } from './protocol'

const POLL_MS = 5000

const containers = atom<ContainerRow[] | null>(null)
const error = atom<string | null>(null)
const updatedAt = atom<number | null>(null)
const busy = atom<readonly string[]>([])
const logs = atom<{ id: string; name: string; text: string } | null>(null)
const notice = atom<string | null>(null)

const query = atom('query', '', { persist: 'plugin' })
const onlyRunning = atom('onlyRunning', false, { persist: 'plugin' })
const collapsed = atom<readonly string[]>('collapsed', [], { persist: 'plugin' })

const NO_PROJECT = 'Avulsos'

const filtered = derived(() => {
  const all = read(containers) ?? []
  const text = read(query).trim().toLowerCase()
  const running = read(onlyRunning)
  return all.filter((c) => {
    if (running && c.state !== 'running') return false
    if (!text) return true
    return [c.name, c.image, c.project ?? '', ...c.ports].some((v) => v.toLowerCase().includes(text))
  })
})

const groups = derived(() => {
  const byProject = new Map<string, ContainerRow[]>()
  for (const c of read(filtered)) {
    const key = c.project ?? NO_PROJECT
    byProject.set(key, [...(byProject.get(key) ?? []), c])
  }
  const runningIn = (rows: ContainerRow[]) => rows.filter((c) => c.state === 'running').length
  return [...byProject.entries()].sort(
    ([nameA, a], [nameB, b]) => runningIn(b) - runningIn(a) || nameA.localeCompare(nameB)
  )
})

function stateTone(state: string): Tone {
  if (state === 'running') return 'success'
  if (state === 'restarting' || state === 'paused') return 'warning'
  if (state === 'dead') return 'danger'
  return 'neutral'
}

async function refresh(): Promise<void> {
  try {
    const result = await plugin.request('containers.list')
    if (result.ok) {
      set(containers, result.containers)
      set(updatedAt, result.at)
      set(error, null)
    } else {
      set(error, result.error)
    }
  } catch (cause) {
    set(error, cause instanceof Error ? cause.message : String(cause))
  }
}

async function act(row: ContainerRow, action: 'start' | 'stop' | 'restart'): Promise<void> {
  update(busy, (ids) => [...ids, row.id])
  try {
    const result = await plugin.request('containers.action', { id: row.id, action })
    set(notice, result.ok ? null : `${row.name}: ${result.error ?? 'falhou'}`)
  } catch (cause) {
    set(notice, `${row.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    update(busy, (ids) => ids.filter((id) => id !== row.id))
    await refresh()
  }
}

async function showLogs(row: ContainerRow): Promise<void> {
  set(logs, { id: row.id, name: row.name, text: 'Carregando...' })
  try {
    const result = await plugin.request('containers.logs', { id: row.id, tail: 200 })
    set(logs, { id: row.id, name: row.name, text: result.text || '(sem saída)' })
  } catch (cause) {
    set(logs, { id: row.id, name: row.name, text: cause instanceof Error ? cause.message : String(cause) })
  }
}

function toggleGroup(name: string, open: boolean): void {
  update(collapsed, (names) => (open ? names.filter((n) => n !== name) : [...names, name]))
}

/** Roda uma vez antes do primeiro render; o que entra em `subscriptions` termina com o painel. */
export function setup(ctx: PanelContext): void {
  void refresh()
  const timer = setInterval(() => {
    // Só consulta o Docker enquanto o painel está visível.
    if (read(ctx.visible)) void refresh()
  }, POLL_MS)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

function ContainerItem({ row }: { row: ContainerRow }) {
  const working = read(busy).includes(row.id)
  const running = row.state === 'running'
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Badge tone={stateTone(row.state)}>{row.state}</Badge>
          <Text weight="medium" truncate>
            {row.name}
          </Text>
        </Row>
        <Row gap="none">
          <IconButton icon="file-text" label={`Logs de ${row.name}`} tooltip="Logs" size="xs" variant="ghost" onPress={() => showLogs(row)} />
          <IconButton icon="refresh" label={`Reiniciar ${row.name}`} tooltip="Reiniciar" size="xs" variant="ghost" disabled={working || !running} onPress={() => act(row, 'restart')} />
          {running ? (
            <IconButton icon="stop" label={`Parar ${row.name}`} tooltip="Parar" size="xs" variant="ghost" tone="danger" disabled={working} onPress={() => act(row, 'stop')} />
          ) : (
            <IconButton icon="play" label={`Iniciar ${row.name}`} tooltip="Iniciar" size="xs" variant="ghost" tone="success" disabled={working} onPress={() => act(row, 'start')} />
          )}
        </Row>
      </Row>
      <Text muted size="xs" truncate>
        {[row.image, ...row.ports].join(' · ')}
      </Text>
      <Text muted size="xs" truncate>
        {row.status}
      </Text>
    </Stack>
  )
}

export default function Panel() {
  const all = read(containers)
  const failure = read(error)
  const stamp = read(updatedAt)
  const log = read(logs)
  const message = read(notice)
  const closed = read(collapsed)
  const total = all?.length ?? 0
  const up = all?.filter((c) => c.state === 'running').length ?? 0

  return (
    <Box padding="sm">
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Heading level={3}>Docker</Heading>
          <Row gap="xs" align="center">
            <Badge tone={up > 0 ? 'success' : 'neutral'}>{`${up}/${total} ativos`}</Badge>
            <IconButton icon="refresh" label="Atualizar" tooltip="Atualizar" size="xs" variant="ghost" onPress={refresh} />
          </Row>
        </Row>

        <Input label="Filtrar containers" labelHidden type="search" placeholder="Filtrar por nome, imagem, porta..." value={read(query)} onChange={(v) => set(query, v)} />
        <Switch label="Somente em execução" checked={read(onlyRunning)} onChange={(v) => set(onlyRunning, v)} />

        {failure ? (
          <Callout tone="danger" title="Não foi possível falar com o Docker">
            <Text size="xs">{failure}</Text>
          </Callout>
        ) : null}
        {message ? (
          <Callout tone="warning" title="Ação não concluída">
            <Text size="xs">{message}</Text>
          </Callout>
        ) : null}

        {log ? (
          <Stack gap="xs">
            <Row justify="between" align="center">
              <Text weight="semibold" truncate>{`Logs · ${log.name}`}</Text>
              <Row gap="none">
                <IconButton icon="refresh" label="Recarregar logs" size="xs" variant="ghost" onPress={() => { const row = (all ?? []).find((c) => c.id === log.id); if (row) void showLogs(row) }} />
                <IconButton icon="close" label="Fechar logs" size="xs" variant="ghost" onPress={() => set(logs, null)} />
              </Row>
            </Row>
            <CodeView code={log.text} label={`Logs de ${log.name}`} wrap maxHeight="lg" />
          </Stack>
        ) : null}

        {all === null && !failure ? <Skeleton shape="text" lines={4} label="Carregando containers" /> : null}

        {all !== null && read(groups).length === 0 ? (
          <EmptyState icon="package" title="Nenhum container" description={total === 0 ? 'O Docker não tem containers.' : 'Nenhum container combina com o filtro.'} />
        ) : null}

        {read(groups).map(([name, rows]) => (
          <Collapsible
            key={name}
            title={`${name} (${rows.filter((c) => c.state === 'running').length}/${rows.length})`}
            open={!closed.includes(name)}
            onChange={(open) => toggleGroup(name, open)}
          >
            <Stack gap="sm">
              {rows.map((row) => (
                <ContainerItem key={row.id} row={row} />
              ))}
            </Stack>
          </Collapsible>
        ))}

        {stamp !== null ? (
          <Text muted size="xs">
            Atualizado <RelativeTime at={stamp} muted />
          </Text>
        ) : null}
      </Stack>
    </Box>
  )
}
