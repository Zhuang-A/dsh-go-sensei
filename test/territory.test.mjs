// test/territory.test.mjs — 简易形势判断（领地估算）的纯函数测试
//
// 领地显示是"形势判断"的落点：画错了等于替棋手宣布地盘归属，比不画更糟。
// 所以这里把归属规则（只挨单色才算地、单官中立）、数子法合计、贴目口径
// 逐项钉死。浏览器 half 有一份同口径实现（client.js 的 estimateTerritory），
// 那边的用例在 test/client.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTerritory, territoryScoreText, formatTerritory } from '../src/territory.js'

/** 空盘：0 空、1 黑、2 白；下标 = y*size+x。 */
function blank(size) {
  return new Array(size * size).fill(0)
}

/** 在网格上摆一圈同色棋子（围出中间的 1 个空点）。 */
function ring(grid, size, cx, cy, color) {
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    grid[(cy + dy) * size + (cx + dx)] = color
  }
}

test('territory: 空盘全是单官，谁也不算地', () => {
  const est = estimateTerritory(blank(9), 9, { komi: 0 })
  assert.equal(est.blackStones + est.whiteStones, 0)
  assert.equal(est.blackTerritory, 0)
  assert.equal(est.whiteTerritory, 0)
  assert.equal(est.dame, 81)
  assert.ok(est.owner.every((v) => v === 0), '空盘上每个点都是中立')
  assert.equal(est.lead, 0)
})

test('territory: 只挨单色的空块才算地，黑白都挨的是单官（不画也不计）', () => {
  const size = 9
  const grid = blank(size)
  ring(grid, size, 2, 2, 1) // 黑圈 8 子，圈住 (2,2)
  ring(grid, size, 6, 6, 2) // 白圈 8 子，圈住 (6,6)
  const est = estimateTerritory(grid, size, { komi: 0 })

  assert.equal(est.owner[2 * size + 2], 1, '黑圈里的空点＝黑地')
  assert.equal(est.owner[6 * size + 6], 2, '白圈里的空点＝白地')
  assert.equal(est.owner[0], 0, '圈外大片空点黑白都挨 → 单官')
  assert.equal(est.owner[1 * size + 1], 1, '盘上的棋子记自己的颜色（黑子）')
  assert.equal(est.owner[5 * size + 5], 2, '白子同理')

  assert.equal(est.blackStones, 8)
  assert.equal(est.whiteStones, 8)
  assert.equal(est.blackTerritory, 1)
  assert.equal(est.whiteTerritory, 1)
  assert.equal(est.dame, 81 - 8 - 8 - 1 - 1, '剩下的都是单官')
  assert.equal(est.blackTotal, 9, '黑＝黑子 8 ＋ 黑地 1')
  assert.equal(est.whiteTotal, 9, '贴目 0 时白＝白子 8 ＋ 白地 1')
  assert.equal(est.lead, 0, '盘面两分')
})

test('territory: 贴目算给白方，领先为正表示黑好', () => {
  const size = 9
  const grid = blank(size)
  ring(grid, size, 2, 2, 1)
  ring(grid, size, 6, 6, 2)
  const est = estimateTerritory(grid, size, { komi: 7.5 })
  assert.equal(est.blackTotal, 9)
  assert.equal(est.whiteTotal, 16.5, '白总计要含贴目')
  assert.equal(est.lead, -7.5, '负数＝白领先')
  assert.ok(!Object.is(est.lead, -0), 'lead 不得是 -0（不是合法 lossless JSON）')

  // 反过来：黑多一颗盘面子、贴目 0 → 黑领先 1
  grid[0] = 1
  const lead = estimateTerritory(grid, size, { komi: 0 })
  assert.equal(lead.lead, 1)
  assert.equal(lead.blackTotal, 10)
})

test('territory: 回归——棋盘格子边的空块也要按邻子判归属', () => {
  // 9 路左上角：黑子在 (1,0)、(0,1)，角上的 (0,0) 与它俩连通成一块，
  // 这块只挨黑子 → 黑地（哪怕这块一直连到盘边）。
  const size = 9
  const grid = blank(size)
  grid[0 * size + 1] = 1
  grid[1 * size + 0] = 1
  grid[1 * size + 1] = 1
  const est = estimateTerritory(grid, size, { komi: 0 })
  // 整盘只有黑子：所有空点都只挨黑子，于是全算黑地
  assert.equal(est.owner[0], 1, '角上的空点贴黑子')
  assert.equal(est.blackStones, 3)
  assert.equal(est.blackTerritory, size * size - 3, '没有白子时，空点全归黑（单色包围的极端情形）')
  assert.equal(est.whiteStones, 0)
  assert.equal(est.dame, 0)
})

test('territory: 调用方给的 grid 不被改写（面板每次翻手都要按同一份重算）', () => {
  const size = 9
  const grid = blank(size)
  ring(grid, size, 4, 4, 2)
  const before = grid.slice()
  estimateTerritory(grid, size, { komi: 3.5 })
  assert.deepEqual(grid, before, '估算不得原地改盘面')
})

test('territory: 畸形输入不抛错（size 非法、grid 缺失）', () => {
  const a = estimateTerritory(undefined, 19, {})
  assert.equal(a.size, 19, '不是数组就当空盘')
  assert.equal(a.blackTerritory + a.whiteTerritory + a.dame, 361)
  const b = estimateTerritory(blank(4), 0, { komi: 'x' })
  assert.equal(b.size, 19, '非法路数退回 19')
  assert.equal(b.komi, 0, '贴目不是数字时按 0')
})

test('territory: 一句话形势判断的文案（含贴目与领先方向）', () => {
  const size = 9
  const grid = blank(size)
  ring(grid, size, 2, 2, 1)
  ring(grid, size, 6, 6, 2)
  grid[0] = 1
  grid[1] = 2
  const est = estimateTerritory(grid, size, { komi: 7.5 })
  assert.equal(
    territoryScoreText(est),
    '黑 10 目 · 白 17.5 目（含贴目 7.5）· 白领先 7.5 目',
  )
  assert.equal(
    formatTerritory(est),
    '简易形势判断（数子估目）：黑 10 目 · 白 17.5 目（含贴目 7.5）· 白领先 7.5 目',
  )
  // 盘面两分（贴目 0、黑白完全对称）时要说"两分"，不能写出"黑领先 0 目"
  const even = estimateTerritory(grid, size, { komi: 0.5 })
  assert.ok(!territoryScoreText(even).includes('领先 0 目'), territoryScoreText(even))
  const draw = estimateTerritory(grid, size, { komi: 0 })
  assert.ok(territoryScoreText(draw).includes('盘面两分'), territoryScoreText(draw))
})
