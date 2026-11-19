import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from './i18n.ts'

test('segue o idioma do Orca e cai para inglês', () => {
  assert.equal(translate('pt-BR', 'active', { up: 1, total: 3 }), '1/3 ativos')
  assert.equal(translate('en-US', 'active', { up: 1, total: 3 }), '1/3 active')
  assert.equal(translate(undefined, 'stop'), 'Stop')
  assert.equal(translate('fr-FR', 'standalone'), 'Standalone')
})

test('substitui variáveis e deixa vazio o que faltar', () => {
  assert.equal(translate('en', 'openPort', { port: 8080 }), 'Open localhost:8080')
  assert.equal(translate('en', 'openPort'), 'Open localhost:')
})
