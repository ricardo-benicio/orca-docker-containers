import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInside, normalizePath, pickWorkspace, type WorkspaceRow } from './workspace.ts'

test('normaliza barras e a barra final', () => {
  assert.equal(normalizePath('/home/a/app/'), '/home/a/app')
  assert.equal(normalizePath('C:\\proj\\app\\'), 'C:/proj/app')
  assert.equal(normalizePath('/'), '/')
})

test('a pasta do compose casa com o workspace só quando é a mesma ou está dentro', () => {
  assert.equal(isInside('/home/a/app', '/home/a/app'), true)
  assert.equal(isInside('/home/a/app/', '/home/a/app'), true)
  assert.equal(isInside('/home/a/app/docker', '/home/a/app'), true)
  assert.equal(isInside('/home/a/app2', '/home/a/app'), false, 'prefixo de nome não vale')
  assert.equal(isInside('/home/a', '/home/a/app'), false, 'a pasta pai do workspace não é do workspace')
  assert.equal(isInside('/home/a/app', '/'), false, 'a raiz não casa com tudo')
  assert.equal(isInside(null, '/home/a/app'), false)
  assert.equal(isInside('/home/a/app', ''), false)
  assert.equal(isInside('C:\\proj\\app\\web', 'C:/proj/app'), true)
})

const rows: WorkspaceRow[] = [
  { id: 'w1', name: 'loja', path: '/home/a/loja', branch: 'main', hostId: 'local' },
  { id: 'w2', name: 'loja', path: '/home/a/loja-feature', branch: 'feature', hostId: null },
  { id: 'w3', name: 'remoto', path: '/srv/remoto', branch: 'main', hostId: 'ssh:box' }
]

test('acha o workspace em foco pelo id, ou por nome e branch quando os ids diferem', () => {
  assert.equal(pickWorkspace({ workspaceId: 'w2', branch: 'feature', displayName: 'loja' }, rows)?.path, '/home/a/loja-feature')
  assert.equal(pickWorkspace({ workspaceId: 'outro-id', branch: 'feature', displayName: 'loja' }, rows)?.path, '/home/a/loja-feature')
  assert.equal(pickWorkspace({ branch: 'main', displayName: 'loja' }, rows)?.path, '/home/a/loja')
})

test('não adivinha: ambíguo, ausente ou remoto dão nada', () => {
  const twin: WorkspaceRow[] = [rows[0]!, { ...rows[0]!, id: 'w9', path: '/outro/loja' }]
  assert.equal(pickWorkspace({ workspaceId: 'x', branch: 'main', displayName: 'loja' }, twin), null)
  assert.equal(pickWorkspace({ workspaceId: 'x', branch: 'main', displayName: 'nada' }, rows), null)
  assert.equal(pickWorkspace({ workspaceId: 'w3', branch: 'main', displayName: 'remoto' }, rows), null)
  assert.equal(pickWorkspace(null, rows), null)
})
