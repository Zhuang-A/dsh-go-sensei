// test/diagram-spec.test.mjs — 配图装配（src/diagram-spec.js）单测
//
// 为什么单独测这一层：配图有两条入口 —— 工具的 go_draw_diagram（要能直接落盘）与
// 面板路由 /go-sensei/diagram（按 URL 参数即时渲染）。两边都走 buildDiagramSpec，
// 所以"第 N 手之后的盘面轮到谁"“越界的手数怎么夹”“归属图挂在哪”只在这里判一次。
// 这一层写错，图上的编号颜色就是反的（历史上真出过同类分歧）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { buildDiagramSpec, diagramMoveOf } from '../src/diagram-spec.js'
import { parseGame } from '../src/sgf.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const load = (name) => parseGame(readFileSync(fixture(name), 'utf8'))

test('diagramMoveOf: 省略＝末手，越界/NaN 一律夹到 [0, 总手数]', () => {
  const game = load('real-analysis.sgf')
  const total = game.moves.length
  assert.ok(total > 0)
  assert.equal(diagramMoveOf(game, undefined), total)
  assert.equal(diagramMoveOf(game, null), total)
  assert.equal(diagramMoveOf(game, ''), total)
  assert.equal(diagramMoveOf(game, 0), 0)
  assert.equal(diagramMoveOf(game, 5.9), 5, '小数向下取整')
  assert.equal(diagramMoveOf(game, -3), 0, '负数夹到开局')
  assert.equal(diagramMoveOf(game, total + 50), total, '超过末手夹到末手')
  assert.equal(diagramMoveOf(game, Number.NaN), total, 'NaN 退回末手')
  assert.equal(diagramMoveOf(game, Number.POSITIVE_INFINITY), total)
})

test('buildDiagramSpec: 变化图起始颜色随基准手数轮转（图上的编号必须与盘面同色）', () => {
  const game = load('real-analysis.sgf')
  const points = (spec) => spec.sequence.points.map((p) => `${p.color}${p.x},${p.y}`)
  // 第 20 手是白 → 之后的盘面轮到黑，变化图第一手默认黑
  const at20 = buildDiagramSpec({ game, move: 20, seqTokens: ['Q16'] })
  assert.equal(at20.move, 20)
  assert.equal(points(at20)[0].charAt(0), 'B')
  // 第 21 手是黑 → 之后轮到白
  const at21 = buildDiagramSpec({ game, move: 21, seqTokens: ['Q16'] })
  assert.equal(points(at21)[0].charAt(0), 'W')
  // 开局（move=0）黑先
  assert.equal(points(buildDiagramSpec({ game, move: 0, seqTokens: ['Q16'] }))[0].charAt(0), 'B')
  // 显式写颜色的项照它，并影响后续轮转
  const explicit = buildDiagramSpec({ game, move: 20, seqTokens: ['W:Q16', 'D4'] })
  assert.deepEqual(points(explicit).map((p) => p.charAt(0)), ['W', 'B'])
  // 解析不了的项如实记在 skipped 里（不静默丢；记号里带形状前缀，与调用方给的原文一致）
  const bad = buildDiagramSpec({ game, move: 20, seqTokens: ['Q99'], markTokens: ['triangle:Z9'] })
  assert.deepEqual(bad.sequence.skipped, ['Q99'])
  assert.deepEqual(bad.marks.skipped, ['triangle:Z9'])
})

test('buildDiagramSpec: 图注截断、宽度夹住、归属图作为页脚画在盘下', () => {
  const game = load('real-analysis.sgf')
  const long = 'x'.repeat(400)
  const spec = buildDiagramSpec({ game, move: 10, caption: long, width: 99 })
  assert.ok(spec.svg.includes('<svg'), '要出 SVG')
  assert.ok(!spec.svg.includes('x'.repeat(200)), '图注要截断（≤120 字）')
  // width 夹到下限 120：SVG 的像素宽度写在 width 属性上
  assert.ok(/width="120"/.test(spec.svg), spec.svg.slice(0, 200))

  const withTerritory = buildDiagramSpec({
    game,
    move: 10,
    territory: { cells: '1'.repeat(361), text: '形势判断：黑 1.0 目' },
  })
  assert.ok(withTerritory.svg.includes('形势判断：黑 1.0 目'), '归属图那行要画进图里')
  assert.ok(!spec.svg.includes('形势判断：黑 1.0 目'), '没给归属图就不该多画')
  // 页脚会占掉盘下一条，视口更高（宽度相同才好比）
  const base = buildDiagramSpec({ game, move: 10, width: 640 })
  const tall = buildDiagramSpec({
    game, move: 10, width: 640,
    territory: { cells: '1'.repeat(361), text: '形势判断：黑 1.0 目' },
  })
  const heightOf = (svg) => Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0)
  assert.ok(heightOf(tall.svg) > heightOf(base.svg), '加了页脚 → 视口更高')
})

test('buildDiagramSpec: 缺棋谱/空盘不抛错（工具与路由都要能安全调用）', () => {
  const empty = { info: { size: 19, players: {} }, moves: [] }
  const spec = buildDiagramSpec({ game: empty })
  assert.equal(spec.move, 0)
  assert.equal(spec.size, 19)
  assert.ok(spec.svg.includes('<svg'))
  // 完全不传 game 也不能炸（极端防御）
  assert.ok(buildDiagramSpec({}).svg.includes('<svg'))
})
