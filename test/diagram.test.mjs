// test/diagram.test.mjs — 讲解配图（变化图 / 重点棋子标注）的纯函数测试
//
// 配图是"追问必须配图"这条纪律的落点：画错了比不画更糟（学生照着错图看棋），
// 所以这里逐项钉死盘面规则、编号顺序、颜色轮转与标注解析。
// 渲染结果是 SVG 字符串，不是 React 元素树，可以直接断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  numberLabel,
  parsePointLabel,
  buildGrid,
  parseSequence,
  parseMarks,
  renderBoardSvg,
  starPoints,
  playerLabels,
  playStone,
  MARK_SHAPES,
} from '../src/diagram.js'

test('diagram: 变化图编号 1-9 之后转 A-Z（用户指定的编号法）', () => {
  assert.equal(numberLabel(0), '1')
  assert.equal(numberLabel(8), '9')
  assert.equal(numberLabel(9), 'A')
  assert.equal(numberLabel(10), 'B')
  assert.equal(numberLabel(34), 'Z')
  assert.equal(numberLabel(35), 'A', '超过 35 手循环取字母（复盘里不会出现）')
  assert.equal(numberLabel(-3), '1', '负数按 0 处理，不产生非法字符')
})

test('diagram: 坐标标签解析（跳过 I、越界返回 null）', () => {
  assert.deepEqual(parsePointLabel('Q16', 19), { x: 15, y: 3 })
  assert.deepEqual(parsePointLabel('A19', 19), { x: 0, y: 0 })
  assert.deepEqual(parsePointLabel('T1', 19), { x: 18, y: 18 })
  assert.deepEqual(parsePointLabel('I3', 19), null, 'I 不是合法列标')
  assert.deepEqual(parsePointLabel('A20', 19), null, '行号越界')
  assert.deepEqual(parsePointLabel('U1', 19), null, '列号越界')
  assert.deepEqual(parsePointLabel('', 19), null)
  assert.deepEqual(parsePointLabel(undefined, 19), null)
  assert.deepEqual(parsePointLabel('Q16', 9), null, '9 路盘上 Q16 不存在')
})

test('diagram: 盘面重放带提子（配图必须和真实局面一致）', () => {
  const board = {
    size: 19,
    moves: [
      { c: 'B', x: 2, y: 3 }, { c: 'W', x: 3, y: 3 }, { c: 'B', x: 4, y: 3 },
      { c: 'B', x: 3, y: 2 }, { c: 'B', x: 3, y: 4 },
    ],
    setup: { black: [], white: [] },
  }
  assert.equal(buildGrid(board, 4)[3 * 19 + 3], 2, '第 4 手后白子还在')
  assert.equal(buildGrid(board, 5)[3 * 19 + 3], 0, '第 5 手提掉白子')
  assert.equal(buildGrid(board, 0).filter((v) => v !== 0).length, 0, '开局空盘')
  assert.equal(buildGrid(board, 99).filter((v) => v !== 0).length, 4, '超出总手数按末手算')

  // 让子摆子
  const handicap = { size: 9, moves: [], setup: { black: [[2, 2], [6, 6]], white: [[4, 4]] } }
  const grid = buildGrid(handicap, 0)
  assert.equal(grid[2 * 9 + 2], 1)
  assert.equal(grid[6 * 9 + 6], 1)
  assert.equal(grid[4 * 9 + 4], 2)
  assert.deepEqual(starPoints(9).length, 9)
  assert.deepEqual(starPoints(19).length, 9)
  assert.deepEqual(starPoints(11), [], '11 路没有标准星位，不硬画')
})

test('diagram: 变化图着法序列——自动轮转 + 显式指定颜色 + 无法解析的项', () => {
  // 第 3 手之后的局面轮到白棋（第 3 手是黑）
  const auto = parseSequence(['Q16', 'D4', 'R6'], 19, 'W')
  assert.deepEqual(auto.points.map((p) => [p.label, p.color, p.x, p.y]), [
    ['1', 'W', 15, 3],
    ['2', 'B', 3, 15],
    ['3', 'W', 16, 13],
  ])
  assert.deepEqual(auto.skipped, [])

  // 显式颜色会改写后续轮转（否则一处手写颜色会把后面全部错开）
  const explicit = parseSequence(['B:Q16', 'D4', 'W:R6'], 19, 'W')
  assert.deepEqual(explicit.points.map((p) => p.color), ['B', 'W', 'W'])

  const bad = parseSequence(['Q16', 'Q20', '', 'ZZ'], 19, 'B')
  assert.equal(bad.points.length, 1, '只保留能解析的那一手')
  assert.deepEqual(bad.skipped, ['Q20', 'ZZ'], '解析不了的项要如实报出来')
})

test('diagram: 重点棋子标注解析（三角形等形状 + 字母 + 非法项）', () => {
  const parsed = parseMarks(['triangle:Q16', 'square:D4', 'circle:C10', 'cross:R6', 'label:Q16:A', 'x:D4'], 19)
  assert.deepEqual(parsed.marks, [
    { x: 15, y: 3, shape: 'triangle' },
    { x: 3, y: 15, shape: 'square' },
    { x: 2, y: 9, shape: 'circle' },
    { x: 16, y: 13, shape: 'cross' },
    { x: 15, y: 3, shape: 'label', text: 'A' },
    { x: 3, y: 15, shape: 'cross' }, // 'x' 是 cross 的简写
  ])
  assert.deepEqual(parseMarks(['blob:Q16', 'triangle:Q20', 'triangle'], 19).skipped,
    ['blob:Q16', 'triangle:Q20', 'triangle'])
  assert.deepEqual(MARK_SHAPES, ['triangle', 'square', 'circle', 'cross', 'label'])
})

test('diagram: 渲染出的 SVG 含图注、编号与三角标注，且做了 XML 转义', () => {
  const grid = buildGrid({
    size: 19,
    moves: [{ c: 'B', x: 15, y: 3 }],
    setup: { black: [], white: [] },
  }, 1)
  const svg = renderBoardSvg({
    size: 19,
    grid,
    numbered: [{ x: 3, y: 15, color: 'W', label: '1' }, { x: 16, y: 12, color: 'B', label: '2' }],
    marks: [{ x: 15, y: 3, shape: 'triangle' }],
    lastMove: { x: 15, y: 3, color: 'B' },
    caption: '黑 <先> & "后"',
    width: 640,
  })
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.slice(0, 80))
  assert.ok(svg.includes('viewBox="0 0 100 107"'), '有图注时视口加高一条')
  assert.ok(svg.includes('width="640"'))
  assert.ok(svg.includes('<polygon'), '三角标注应画成 polygon')
  // 编号文字按顺序出现（1、2 各自在正确的坐标上）
  assert.ok(/>1<\/text>/.test(svg) && />2<\/text>/.test(svg), '变化图编号要写在棋子正中')
  assert.ok(!svg.includes('黑 <先>'), '图注要转义，不能把 < > 直接写进 XML')
  assert.ok(svg.includes('黑 &lt;先&gt; &amp; &quot;后&quot;'), '转义结果')
  // 无图注时视口高度回到 100
  const plain = renderBoardSvg({ size: 19, grid, numbered: [], marks: [] })
  assert.ok(plain.includes('viewBox="0 0 100 100"'))
  assert.ok(!plain.includes('<polygon'))
  // 越界的标注/编号不画，也不抛错（编号棋子另有淡蓝描边，盘面棋子上没有）
  const small = renderBoardSvg({
    size: 9,
    grid: buildGrid({ size: 9, moves: [], setup: {} }, 0),
    numbered: [{ x: 15, y: 3, color: 'B', label: '1' }],
  })
  assert.ok(!small.includes('stroke="#7dd3fc"'), '9 路盘上画不出 19 路的点')
})

test('diagram: 盘上沿写黑方白方的名字（棋谱没名字时不占名条）', () => {
  const grid = buildGrid({ size: 19, moves: [], setup: { black: [], white: [] } }, 0)
  const svg = renderBoardSvg({
    size: 19,
    grid,
    players: { black: '庄生梦1n4k', white: '鍾易成1', blackRank: '18级', whiteRank: '17级' },
    caption: '白 1 断',
  })
  assert.ok(svg.includes('viewBox="0 0 100 113"'), '名条 6 + 盘面 100 + 图注 7')
  assert.ok(svg.includes('黑 庄生梦1n4k（18级）'), '黑方名字要写在盘上')
  assert.ok(svg.includes('白 鍾易成1（17级）'), '白方名字要写在盘上')
  assert.ok(svg.includes('<g transform="translate(0,6)">'), '盘面内容整体下移一条名条')
  assert.ok(svg.includes('y="110.6"'), '图注仍排在名条 + 盘面之下')

  // 没有棋手名时不占名条（老棋谱的渲染结果与从前一致）
  const plain = renderBoardSvg({ size: 19, grid, caption: '变化图' })
  assert.ok(plain.includes('viewBox="0 0 100 107"'))
  assert.ok(plain.includes('<g transform="translate(0,0)">'))
  assert.ok(!plain.includes('黑 '), '没名字就不该有名条文字')

  // 名字里的 XML 字符要转义（棋手名是自由文本）
  const risky = renderBoardSvg({
    size: 9,
    grid: buildGrid({ size: 9, moves: [], setup: {} }, 0),
    players: { black: 'a<b>&"c' },
  })
  assert.ok(risky.includes('黑 a&lt;b&gt;&amp;&quot;c'))

  // 名字/段位的组合写法
  assert.deepEqual(playerLabels({ black: '甲', blackRank: '3段' }), { black: '甲（3段）', white: '' })
  assert.deepEqual(playerLabels({ whiteRank: '9级' }), { black: '', white: '9级' })
  assert.deepEqual(playerLabels({ black: '  甲  ', white: '乙' }), { black: '甲', white: '乙' })
  assert.deepEqual(playerLabels(null), { black: '', white: '' })
})

// ---------------------------------------------------------------------------
// 盘外坐标不该污染逐格数组（2026-09 复审）
//
// coordLabel 对盘外坐标会原样返回 x/y，而 buildGrid 原先只挡 < 0 —— 一个
// 19 路上的 B[zz]（x=y=25）会把 grid 撑成 501 长度的稀疏数组，渲染就多画格子。
// ---------------------------------------------------------------------------

test('buildGrid: 盘外坐标被忽略，grid 长度恒为 size*size', () => {
  const board = { size: 19, moves: [{ x: 25, y: 25, c: 'B' }, { x: 3, y: 3, c: 'W' }], setup: {} }
  const grid = buildGrid(board, 2)
  assert.equal(grid.length, 19 * 19, '越界坐标不得扩展数组')
  assert.equal(grid.every((v) => v === 0), false, '合法的那一手仍要落子')
  assert.equal(grid[3 * 19 + 3], 2, '白子在 (3,3)')

  // 越界坐标全部丢弃时，盘面必须干净
  const onlyOutside = buildGrid({ size: 19, moves: [{ x: -1, y: 5, c: 'B' }, { x: 5, y: 99, c: 'W' }], setup: {} }, 2)
  assert.equal(onlyOutside.length, 19 * 19)
  assert.ok(onlyOutside.every((v) => v === 0))

  // playStone 自身也要挡住盘外（它被多处直接调用）
  const g = buildGrid({ size: 9, moves: [], setup: {} }, 0)
  playStone(g, 9, 42, 42, 1)
  assert.equal(g.length, 9 * 9, 'playStone 不得写入盘外下标')
})

test('buildGrid/renderBoardSvg: 摆子越界、超大宽度、越界最后一手都被挡住', () => {
  const grid = buildGrid({ size: 9, moves: [], setup: { black: [[99, 99]], white: [[-3, 2], [4, 4]] } }, 0)
  assert.equal(grid.length, 9 * 9, '越界摆子不得扩展数组')
  assert.equal(grid[4 * 9 + 4], 2, '同一批里合法的那颗白子仍要摆上')

  assert.ok(renderBoardSvg({ size: 9, grid, width: 999999 }).includes('width="1600"'), '宽度上限 1600')
  assert.ok(renderBoardSvg({ size: 9, grid, width: 10 }).includes('width="120"'), '宽度下限 120')

  // lastMove 越界：输出必须与"不传 lastMove"完全一致（等于整支笔画被跳过）
  const without = renderBoardSvg({ size: 9, grid })
  const withBad = renderBoardSvg({ size: 9, grid, lastMove: { x: 40, y: 40, color: 'B' } })
  assert.equal(withBad, without, '越界的最后一手不得画到盘外')
})
