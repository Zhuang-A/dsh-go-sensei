// test/derived.test.mjs — 派生文件命名规则（源棋谱只读，复盘产物落在 -sensei 副本）
//
// 这条规则是"不要覆盖源文件"的全部实现：写回目标由源路径推出，读也优先用已存在的副本，
// 两边都必须幂等 —— 否则第二次复盘会写出 `xxx-sensei-sensei.sgf`，或者把副本当成新源。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { senseiPathFor, diagramPathFor, SENSEI_SUFFIX, DIAGRAM_DIR } from '../src/derived.js'

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

// ---------------------------------------------------------------------------
// 配图文件名（diagramPathFor）：指纹形态必须自己把关
//
// 返回值就是写盘 / 读取路径，而指纹会被拼进文件名。若不校验形态，`x/../../../evil`
// 这种值经 join() 规范化后会越出 `.go-sensei/`，变成"在预期目录之外创建 .svg"
// （2026-09-30 DeepSec L3 报 Medium）。所以这一层 fail-closed。
// ---------------------------------------------------------------------------

test('diagramPathFor: 只认短十六进制指纹，落点固定在 .go-sensei/ 之内', () => {
  const sgf = `C:${sep}QiPu${sep}game.sgf`
  assert.equal(diagramPathFor(sgf, '9b532f6da450'),
    join(`C:${sep}QiPu`, DIAGRAM_DIR, 'diagram-9b532f6da450.svg'))
  // 纯相对路径：落在当前目录下的 .go-sensei/
  assert.equal(diagramPathFor('game.sgf', 'abcdef12'), join(DIAGRAM_DIR, 'diagram-abcdef12.svg'))
  // 形态不对：一律空串（调用方会当成"没生成文件"处理）
  for (const bad of ['', 'x/../../../evil', '..', 'ABCDEF12', 'abc', 'hash with space', '9b532f6da450/../x', 'z'.repeat(80)]) {
    assert.equal(diagramPathFor(sgf, bad), '', `不该接受指纹：${JSON.stringify(bad)}`)
  }
  assert.equal(diagramPathFor('', 'abcdef12'), '')
  assert.equal(diagramPathFor(undefined, undefined), '')
})
