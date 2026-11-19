// Sem build: o Orca remove os tipos e compila o JSX quando o painel carrega.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  derived,
  EmptyState,
  env,
  Heading,
  IconButton,
  Input,
  KeyValue,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  settings,
  shell,
  Skeleton,
  Stack,
  Switch,
  Text,
  update,
  type PanelContext
} from 'orca'
import { lookOf, type Look } from './format'
import { translate, type Key } from './i18n'
import type { Action, ContainerInfo, ContainerRow, DockerErrorCode, TerminalKind } from './protocol'

/** Rede de segurança: os eventos do Docker já atualizam a lista na hora. Ajustável nas configurações. */
const DEFAULT_POLL_SECONDS = 30
const STANDALONE = '__standalone'

const containers = atom<ContainerRow[] | null>(null)
const failure = atom<{ code: DockerErrorCode; error: string } | null>(null)
const updatedAt = atom<number | null>(null)
const busy = atom<readonly string[]>([])
const logs = atom<{ id: string; name: string; text: string } | null>(null)
const notice = atom<string | null>(null)
const detail = atom<{ row: ContainerRow; info: ContainerInfo | null; error: string | null } | null>(null)

const query = atom('query', '', { persist: 'plugin' })
const onlyRunning = atom('onlyRunning', false, { persist: 'plugin' })
const collapsed = atom<readonly string[]>('collapsed', [], { persist: 'plugin' })

const t = (key: Key, vars?: Record<string, string | number>): string => translate(env.locale, key, vars)

const groups = derived(() => {
  const text = read(query).trim().toLowerCase()
  const running = read(onlyRunning)
  const byProject = new Map<string, ContainerRow[]>()
  for (const c of read(containers) ?? []) {
    if (running && c.state !== 'running') continue
    const haystack = [c.name, c.image, c.project ?? '', ...c.ports.map((p) => String(p.host))]
    if (text && !haystack.some((v) => v.toLowerCase().includes(text))) continue
    const key = c.project ?? STANDALONE
    byProject.set(key, [...(byProject.get(key) ?? []), c])
  }
  const up = (rows: ContainerRow[]) => rows.filter((c) => c.state === 'running').length
  return [...byProject.entries()].sort(([a, rowsA], [b, rowsB]) => up(rowsB) - up(rowsA) || a.localeCompare(b))
})

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function refresh(): Promise<void> {
  try {
    const result = await plugin.request('containers.list')
    if (result.ok) {
      set(containers, result.containers)
      set(updatedAt, result.at)
      set(failure, null)
    } else {
      set(failure, { code: result.code, error: result.error })
    }
  } catch (cause) {
    set(failure, { code: 'unknown', error: errorText(cause) })
  }
}

async function withBusy(ids: readonly string[], work: () => Promise<string | null>): Promise<void> {
  update(busy, (current) => [...current, ...ids])
  try {
    set(notice, await work())
  } catch (cause) {
    set(notice, errorText(cause))
  } finally {
    update(busy, (current) => current.filter((id) => !ids.includes(id)))
    await refresh()
  }
}

function act(row: ContainerRow, action: Action): Promise<void> {
  return withBusy([row.id], async () => {
    const result = await plugin.request('containers.action', { id: row.id, action })
    return result.ok ? null : `${row.name}: ${result.error ?? t('failed')}`
  })
}

function actProject(project: string, rows: ContainerRow[], action: Action): Promise<void> {
  return withBusy(
    rows.map((row) => row.id),
    async () => {
      const result = await plugin.request('project.action', { project, action })
      return result.ok ? null : `${project}: ${result.error ?? t('failed')}`
    }
  )
}

async function showLogs(row: ContainerRow): Promise<void> {
  set(logs, { id: row.id, name: row.name, text: t('logsLoading') })
  try {
    const result = await plugin.request('containers.logs', { id: row.id, tail: 200 })
    set(logs, { id: row.id, name: row.name, text: result.text || t('logsEmpty') })
  } catch (cause) {
    set(logs, { id: row.id, name: row.name, text: errorText(cause) })
  }
}

async function showDetail(row: ContainerRow): Promise<void> {
  set(detail, { row, info: null, error: null })
  try {
    const result = await plugin.request('containers.inspect', { id: row.id })
    set(detail, result.ok ? { row, info: result.info, error: null } : { row, info: null, error: result.error })
  } catch (cause) {
    set(detail, { row, info: null, error: errorText(cause) })
  }
}

async function openTerminal(row: ContainerRow, kind: TerminalKind): Promise<void> {
  try {
    const result = await plugin.request('containers.terminal', { id: row.id, kind, name: row.name })
    set(notice, result.ok ? null : (result.error ?? t('terminalFailed')))
  } catch (cause) {
    set(notice, errorText(cause))
  }
}

function toggleGroup(key: string, open: boolean): void {
  update(collapsed, (keys) => (open ? keys.filter((k) => k !== key) : [...keys, key]))
}

/** Roda uma vez antes do primeiro render; o que entra em `subscriptions` termina com o painel. */
export function setup(ctx: PanelContext): void {
  void refresh()
  ctx.subscriptions.push(plugin.on('containers.changed', () => void refresh()))
  let timer: ReturnType<typeof setInterval> | null = null
  const arm = async (): Promise<void> => {
    if (timer) clearInterval(timer)
    let seconds = DEFAULT_POLL_SECONDS
    try {
      const value = await settings.get('pollSeconds')
      if (typeof value === 'number' && Number.isFinite(value)) seconds = Math.min(Math.max(value, 10), 300)
    } catch {
      // Sem configurações: usa o padrão.
    }
    timer = setInterval(() => {
      if (read(ctx.visible)) void refresh()
    }, seconds * 1000)
  }
  void arm()
  ctx.subscriptions.push(settings.onDidChange(() => void arm()))
  ctx.subscriptions.push({ dispose: () => timer && clearInterval(timer) })
}

function stateKey(word: NonNullable<Look['word']>): Key {
  return `state${word[0]!.toUpperCase()}${word.slice(1)}` as Key
}

function ContainerItem({ row }: { row: ContainerRow }) {
  const working = read(busy).includes(row.id)
  const running = row.state === 'running'
  const look = lookOf(row)
  const wordText = look.word ? (look.code !== null ? `${t(stateKey(look.word))} (${look.code})` : t(stateKey(look.word))) : null
  const ageText = look.age && (look.word === 'exited' || look.word === 'restarting') ? t('ago', { time: look.age }) : look.age
  return (
    <Box background={look.problem ?? 'none'} radius="sm" paddingX="xs" paddingY="xs">
      <Stack gap="none">
        <Row justify="between" align="center" gap="xs">
          <Row gap="xs" align="center">
            <Text tone={look.tone}>{look.filled ? '●' : '○'}</Text>
            <Text weight="medium" truncate>
              {row.name}
            </Text>
          </Row>
          <Row gap="none">
            <IconButton icon="info" label={t('detailsOf', { name: row.name })} tooltip={t('details')} size="xs" variant="ghost" onPress={() => showDetail(row)} />
            <IconButton icon="file-text" label={t('logsOf', { name: row.name })} tooltip={t('logs')} size="xs" variant="ghost" onPress={() => showLogs(row)} />
            <IconButton icon="refresh" label={t('restartName', { name: row.name })} tooltip={t('restart')} size="xs" variant="ghost" disabled={working || !running} onPress={() => act(row, 'restart')} />
            {running ? (
              <IconButton icon="stop" label={t('stopName', { name: row.name })} tooltip={t('stop')} size="xs" variant="ghost" disabled={working} onPress={() => act(row, 'stop')} />
            ) : (
              <IconButton icon="play" label={t('startName', { name: row.name })} tooltip={t('start')} size="xs" variant="ghost" disabled={working} onPress={() => act(row, 'start')} />
            )}
          </Row>
        </Row>
        <Row gap="xs" align="center" wrap>
          <Text muted size="xs" truncate>
            {row.image}
          </Text>
          {wordText ? (
            <Text size="xs" tone={look.tone === 'neutral' ? undefined : look.tone} muted={look.tone === 'neutral'}>
              {`· ${wordText}`}
            </Text>
          ) : null}
          {ageText ? (
            <Text muted size="xs">
              {`· ${ageText}`}
            </Text>
          ) : null}
          {row.ports.map((port, index) => (
            <Row key={`${port.host}:${port.container}`} gap="none" align="center">
              <Text muted size="xs">{`${index === 0 && (wordText || ageText) ? '· ' : ''}${port.host}→${port.container}`}</Text>
              <IconButton
                icon="open-external"
                label={t('openPort', { port: port.host })}
                tooltip={t('openPort', { port: port.host })}
                size="xs"
                variant="ghost"
                onPress={() => shell.openExternal(`http://localhost:${port.host}`)}
              />
            </Row>
          ))}
        </Row>
      </Stack>
    </Box>
  )
}

function DetailView({ view }: { view: { row: ContainerRow; info: ContainerInfo | null; error: string | null } }) {
  const { row, info, error } = view
  const none = t('detailNone')
  const items = info
    ? [
        { label: t('detailId'), value: info.id, code: true },
        { label: t('detailImage'), value: info.image || none, code: true },
        { label: t('detailCreated'), value: info.created ? info.created.slice(0, 19).replace('T', ' ') + ' UTC' : none },
        { label: t('detailCommand'), value: info.command || none, code: true },
        { label: t('detailRestart'), value: info.restart },
        { label: t('detailNetworks'), value: info.networks.length ? info.networks.map((n) => (n.ip ? `${n.name} (${n.ip})` : n.name)).join(', ') : none },
        ...(info.mounts.length
          ? info.mounts.map((m, i) => ({
              label: i === 0 ? t('detailVolumes') : '',
              value: `${m.source || m.type} → ${m.destination}${m.rw ? '' : ' (ro)'}`,
              code: true
            }))
          : [{ label: t('detailVolumes'), value: none }])
      ]
    : []
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text weight="semibold" truncate>{row.name}</Text>
        <IconButton icon="close" label={t('closeDetails')} size="xs" variant="ghost" onPress={() => set(detail, null)} />
      </Row>
      {error ? <Text size="xs" tone="danger">{error}</Text> : null}
      {info ? <KeyValue items={items} /> : error ? null : <Skeleton shape="text" lines={4} label={t('loadingDetails')} />}
      <Row gap="xs" wrap>
        {row.state === 'running' ? (
          <Button size="xs" variant="outline" icon="terminal" onPress={() => openTerminal(row, 'shell')}>{t('openShell')}</Button>
        ) : null}
        <Button size="xs" variant="outline" icon="terminal" onPress={() => openTerminal(row, 'logs')}>{`${t('followLogs')} ${t('inTerminal')}`}</Button>
      </Row>
    </Stack>
  )
}

function ProjectActions({ project, rows }: { project: string; rows: ContainerRow[] }) {
  const working = rows.some((row) => read(busy).includes(row.id))
  const anyUp = rows.some((row) => row.state === 'running')
  const anyDown = rows.some((row) => row.state !== 'running')
  return (
    <Row gap="none">
      <IconButton icon="play" label={t('startAll')} tooltip={t('startAll')} size="xs" variant="ghost" disabled={working || !anyDown} onPress={() => actProject(project, rows, 'start')} />
      <IconButton icon="refresh" label={t('restartAll')} tooltip={t('restartAll')} size="xs" variant="ghost" disabled={working || !anyUp} onPress={() => actProject(project, rows, 'restart')} />
      <IconButton icon="stop" label={t('stopAll')} tooltip={t('stopAll')} size="xs" variant="ghost" disabled={working || !anyUp} onPress={() => actProject(project, rows, 'stop')} />
    </Row>
  )
}

/** Cabeçalho do grupo: recolhe/expande à esquerda, ações do projeto à direita, na mesma linha. */
function GroupHeader({ id, label, group, open }: { id: string; label: string; group: ContainerRow[]; open: boolean }) {
  const up = group.filter((c) => c.state === 'running').length
  return (
    <Row justify="between" align="center" gap="xs">
      <Row gap="xs" align="center">
        <Button size="xs" variant="ghost" icon={open ? 'expand' : 'next'} onPress={() => toggleGroup(id, !open)}>
          {label}
        </Button>
        <Text muted size="xs">{`${up}/${group.length}`}</Text>
      </Row>
      {id === STANDALONE ? null : <ProjectActions project={id} rows={group} />}
    </Row>
  )
}

export default function Panel() {
  const all = read(containers)
  const problem = read(failure)
  const stamp = read(updatedAt)
  const log = read(logs)
  const detailView = read(detail)
  const message = read(notice)
  const closed = read(collapsed)
  const rows = read(groups)
  const total = all?.length ?? 0
  const up = all?.filter((c) => c.state === 'running').length ?? 0
  const errKey = problem ? (`err${problem.code[0]?.toUpperCase()}${problem.code.slice(1)}` as Key) : null
  const hintKey = problem ? (`hint${problem.code[0]?.toUpperCase()}${problem.code.slice(1)}` as Key) : null

  return (
    <Box padding="sm">
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Heading level={3}>{t('title')}</Heading>
          <Row gap="xs" align="center">
            <Badge tone={up > 0 ? 'success' : 'neutral'}>{t('active', { up, total })}</Badge>
            <IconButton icon="refresh" label={t('refresh')} tooltip={t('refresh')} size="xs" variant="ghost" onPress={refresh} />
          </Row>
        </Row>

        <Input label={t('filterLabel')} labelHidden type="search" placeholder={t('filterPlaceholder')} value={read(query)} onChange={(v) => set(query, v)} />
        <Switch label={t('onlyRunning')} checked={read(onlyRunning)} onChange={(v) => set(onlyRunning, v)} />

        {problem && errKey && hintKey ? (
          <Callout tone="danger" title={t(errKey)}>
            <Stack gap="xs">
              {t(hintKey) ? <Text size="xs">{t(hintKey)}</Text> : null}
              <Text muted size="xs">{problem.error}</Text>
            </Stack>
          </Callout>
        ) : null}
        {message ? (
          <Callout tone="warning" title={t('actionFailed')}>
            <Text size="xs">{message}</Text>
          </Callout>
        ) : null}

        {detailView ? <DetailView view={detailView} /> : null}

        {log ? (
          <Stack gap="xs">
            <Row justify="between" align="center">
              <Text weight="semibold" truncate>{t('logsTitle', { name: log.name })}</Text>
              <Row gap="none">
                <IconButton icon="refresh" label={t('reloadLogs')} size="xs" variant="ghost" onPress={() => { const row = (all ?? []).find((c) => c.id === log.id); if (row) void showLogs(row) }} />
                <IconButton icon="close" label={t('closeLogs')} size="xs" variant="ghost" onPress={() => set(logs, null)} />
              </Row>
            </Row>
            <CodeView code={log.text} label={t('logsOf', { name: log.name })} wrap maxHeight="lg" />
          </Stack>
        ) : null}

        {all === null && !problem ? <Skeleton shape="text" lines={4} label={t('loadingContainers')} /> : null}

        {all !== null && rows.length === 0 ? (
          <EmptyState icon="package" title={t('noContainers')} description={total === 0 ? t('dockerEmpty') : t('filterEmpty')} />
        ) : null}

        {rows.map(([key, group]) => {
          const label = key === STANDALONE ? t('standalone') : key
          const open = !closed.includes(key)
          return (
            <Stack key={key} gap="xs">
              <GroupHeader id={key} label={label} group={group} open={open} />
              {open ? group.map((row) => <ContainerItem key={row.id} row={row} />) : null}
            </Stack>
          )
        })}

        {stamp !== null ? (
          <Text muted size="xs">
            {t('updated')} <RelativeTime at={stamp} muted />
          </Text>
        ) : null}
      </Stack>
    </Box>
  )
}
