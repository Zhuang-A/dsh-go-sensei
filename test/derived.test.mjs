// test/derived.test.mjs — 派生文件命名规则（源棋谱只读，复盘产物落在 -sensei 副本）
//
// 这条规则是"不要覆盖源文件"的全部实现：写回目标由源路径推出，读也优先用已存在的副本，
// 两边都必须幂等 —— 否则第二次复盘会写出 `xxx-sensei-sensei.sgf`，或者把副本当成新源。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { senseiPathFor, SENSEI_SUFFIX } from '../src/derived.js'

test('senseiPathFor: 同目录、文件名插 -sensei', () => {
  assert.equal(senseiPathFor('game.sgf'), `game${SENSEI_SUFFIX}.sgf`)
  assert.equal(
    senseiPathFor(`C:${sep}QiPu${sep}0913[甲]vs[乙].sgf`),
    `C:${sep}QiPu${sep}0913[甲]vs[乙]${SENSEI_SUFFIX}.sgf`,
  )
  // 相对路径带目录
  assert.equal(senseiPathFor(`review-check${sep}a.sgf`), `review-check${sep}a${SENSEI_SUFFIX}.sgf`)
})

test('senseiPathFor: 幂等（副本再推一次还是它自己）', () => {
  const copy = senseiPathFor('game.sgf')
  assert.equal(senseiPathFor(copy), copy)
  assert.equal(senseiPathFor(`C:${sep}x${sep}game${SENSEI_SUFFIX}.sgf`), `C:${sep}x${sep}game${SENSEI_SUFFIX}.sgf`)
})

test('senseiPathFor: 大小写与非 sgf 扩展名', () => {
  assert.equal(senseiPathFor('GAME.SGF'), 'GAME-sensei.SGF')
  assert.equal(senseiPathFor('game-sensei.SGF'), 'game-sensei.SGF')
  // 没有扩展名：后缀接在末尾
  assert.equal(senseiPathFor('game'), 'game-sensei')
  // 空输入不炸
  assert.equal(senseiPathFor(''), '')
  assert.equal(senseiPathFor(undefined), '')
})
