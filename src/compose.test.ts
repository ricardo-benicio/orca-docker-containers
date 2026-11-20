import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeCommand, forget, isSafeLocalPath, loadRefs, remember, sameRefs, toRef, type ComposeRef } from './compose.ts'
import { configureDocker, parseDetailed } from './docker.ts'

const ref: ComposeRef = { project: 'loja', dir: '/home/a/loja', files: ['/home/a/loja/compose.yaml', '/home/a/loja/compose.dev.yaml'], envFiles: ['/home/a/loja/.env'], seenAt: 10 }

test('só aceita caminho absoluto, curto e sem aspa nem caractere de controle', () => {
  assert.equal(isSafeLocalPath('/home/a/My Projects/loja'), true, 'espaço é comum e vai entre aspas')
  assert.equal(isSafeLocalPath('C:\\proj\\loja'), true)
  assert.equal(isSafeLocalPath('relativo/compose.yaml'), false)
  assert.equal(isSafeLocalPath('-f'), false)
  assert.equal(isSafeLocalPath("/a/b'; rm -rf ~ #"), false)
  assert.equal(isSafeLocalPath('/a/b\nrm -rf ~'), false)
  assert.equal(isSafeLocalPath('/a/b\u0000'), false)
  assert.equal(isSafeLocalPath(''), false)
  assert.equal(isSafeLocalPath('/' + 'a'.repeat(600)), false)
  assert.equal(isSafeLocalPath(42), false)
})

test('monta o up com os arquivos do projeto, cada um entre aspas', () => {
  configureDocker({ path: 'docker', context: '' })
  assert.equal(
    composeCommand('up', 'loja', ref),
    "docker compose -p 'loja' --project-directory '/home/a/loja' -f '/home/a/loja/compose.yaml' -f '/home/a/loja/compose.dev.yaml' --env-file '/home/a/loja/.env' up -d"
  )
})

test('o down leva só o nome do projeto e nunca apaga volumes', () => {
  configureDocker({ path: 'docker', context: '' })
  const down = composeCommand('down', 'loja', null)
  assert.equal(down, "docker compose -p 'loja' down")
  assert.equal(/ -v\b|--volumes|--rmi/.test(down ?? ''), false)
})

test('respeita o binário e o contexto configurados', () => {
  configureDocker({ path: '/usr/bin/docker', context: 'colima' })
  assert.equal(composeCommand('down', 'loja', null), "/usr/bin/docker --context colima compose -p 'loja' down")
  configureDocker({ path: 'docker', context: '' })
})

test('recusa projeto inválido, up sem arquivos conhecidos e registro adulterado', () => {
  assert.equal(composeCommand('down', "x'; id #", null), null)
  assert.equal(composeCommand('down', '--all', null), null)
  assert.equal(composeCommand('up', 'loja', null), null)
  assert.equal(composeCommand('up', 'outro', ref), null, 'registro de outro projeto não serve')
  assert.equal(composeCommand('up', 'loja', { ...ref, files: ["/a'; rm -rf ~ #"] }), null)
  assert.equal(composeCommand('up', 'loja', { ...ref, dir: 'relativo' }), null)
  assert.equal(composeCommand('up', 'loja', { ...ref, files: [] }), null)
})

test('o que vem do storage é limpo: lixo e caminhos perigosos somem', () => {
  const stored = [ref, { ...ref, project: 'ruim', files: ["/a'; id #"] }, { project: 'x' }, 'texto', null, { ...ref, project: 'b', files: Array(25).fill('/a/c.yaml') }]
  assert.deepEqual(loadRefs(stored).map((r) => r.project), ['loja'])
  assert.deepEqual(loadRefs('não é lista'), [])
  assert.equal(toRef({ ...ref, envFiles: undefined })?.envFiles.length, 0)
})

const labels = (project: string, dir: string, files: string) => `com.docker.compose.project=${project},com.docker.compose.project.config_files=${files},com.docker.compose.project.working_dir=${dir}`
const ps = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join('\n')

test('lembra projetos vistos na lista, mais recentes primeiro, e ignora avulsos', () => {
  const rows = parseDetailed(
    ps(
      { ID: 'aaaaaaaaaaaa', Names: 'loja-web-1', Labels: labels('loja', '/home/a/loja', '/home/a/loja/compose.yaml,/home/a/loja/o.yaml') },
      { ID: 'bbbbbbbbbbbb', Names: 'solo', Labels: '' },
      { ID: 'cccccccccccc', Names: 'sem-pasta', Labels: 'com.docker.compose.project=quebrado' }
    )
  )
  const found = remember([], rows, 500)
  assert.deepEqual(found.map((r) => [r.project, r.dir, r.files, r.seenAt]), [['loja', '/home/a/loja', ['/home/a/loja/compose.yaml', '/home/a/loja/o.yaml'], 500]])
  const older: ComposeRef = { ...ref, project: 'antigo', seenAt: 1 }
  assert.deepEqual(remember([older], rows, 500).map((r) => r.project), ['loja', 'antigo'])
  assert.equal(remember([{ ...ref, project: 'loja', dir: '/velho', seenAt: 1 }], rows, 500)[0]?.dir, '/home/a/loja', 'a leitura mais nova substitui')
})

test('limita a 30 projetos, descartando os mais antigos', () => {
  const known = Array.from({ length: 35 }, (_, i): ComposeRef => ({ ...ref, project: `p${String(i).padStart(2, '0')}`, seenAt: i }))
  const kept = remember(known, [], 100)
  assert.equal(kept.length, 30)
  assert.equal(kept[0]?.project, 'p34')
  assert.equal(kept.some((r) => r.project === 'p00'), false)
})

test('esquece um projeto e sabe quando a lista não mudou', () => {
  assert.deepEqual(forget([ref, { ...ref, project: 'b' }], 'loja').map((r) => r.project), ['b'])
  assert.equal(sameRefs([ref], [{ ...ref, seenAt: 999 }]), true, 'só o horário mudou: não precisa gravar')
  assert.equal(sameRefs([ref], [{ ...ref, dir: '/outro' }]), false)
})
