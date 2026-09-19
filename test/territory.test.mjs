// test/territory.test.mjs — 形势判断（引擎归属图 → 黑地/白地/未定三档）
//
// 规则照 Lizzieyzy 的 KataEstimate.java（用户 2026-09-19 指定）：
//   ① 阈值 0.4：|归属| 低于它的点算未定（不画、不计）
//   ② 四邻过滤：空点要四个邻点都不倾向对方，才算自己的地
//   ③ 死子：落在对方区域里的己方棋子按死子算，画对方的方块、记进对方的「地」
// 计分用数子法：目 = 活子 + 地；领先 = 黑目 − 白目 − 贴目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TERRITORY_THRESHOLD,
  cellsFromOwnership,
  createReplayer,
  estimateTerritory,
  estimateTerritorySeries,
  packTerritory,
  replayTo,
  scoreFromCells,
  territoryScoreText,
  unpackTerritory,
} from '../src/territory.js'

/** 造一个 5 路空盘（0 空 / 1 黑 / 2 白）。 */
const emptyBoard = (size = 5) => new Array(size * size).fill(0)

test('territory: 阈值 0.4 —— 低于它的点算未定，不画也不计', () => {
  assert.equal(TERRITORY_THRESHOLD, 0.4)
  const size = 5
  const board = emptyBoard(size)
  // 四邻都给同一色，好让四邻过滤不干扰阈值这件事
  const ownership = new Array(size * size).fill(0.35)
  ownership[2 * size + 2] = 0.35
  const est = estimateTerritory(board, size, { ownership, komi: 0 })
  assert.equal(est.cells[2 * size + 2], 0, '0.35 < 0.4 → 未定')
  assert.equal(est.blackTerritory, 0)
  assert.equal(est.lead, 0, '双方都是 0 → 持平')

  const strong = new Array(size * size).fill(0.4)
  const est2 = estimateTerritory(board, size, { ownership: strong, komi: 0 })
  assert.equal(est2.cells[2 * size + 2], 1, '正好 0.4 → 算黑地（>= 阈值）')
  assert.equal(est2.blackTerritory, size * size)
})

test('territory: 四邻过滤 —— 只要有一个邻点不倾向自己，空点就不算地', () => {
  const size = 5
  const board = emptyBoard(size)
  const ownership = new Array(size * size).fill(0)
  // 角上的 (0,0)：两个在盘内的邻点都不倾向白（0 也算"不倾向白"）→ 通过
  ownership[0 * size + 0] = 0.5
  // 中间的 (2,2)：右边邻点是 -0.5（倾向白）→ 不通过
  ownership[2 * size + 2] = 0.5
  ownership[2 * size + 3] = -0.5
  const est = estimateTerritory(board, size, { ownership, komi: 0 })
  assert.equal(est.cells[0], 1, '四邻都不倾向白 → 黑地')
  assert.equal(est.cells[2 * size + 2], 0, '有个邻点倾向白 → 不算地（防孤点）')
  assert.equal(est.blackTerritory, 1)
})

test('territory: 死子 —— 落在对方区域里的己方棋子画对方方块并记给对方', () => {
  const size = 5
  const board = emptyBoard(size)
  board[1 * size + 1] = 1 // 一颗黑子
  board[3 * size + 3] = 2 // 一颗白子
  const ownership = new Array(size * size).fill(0)
  ownership[1 * size + 1] = -0.9 // 归给白 = 死黑子
  ownership[3 * size + 3] = 0.9 // 归给黑 = 死白子
  const est = estimateTerritory(board, size, { ownership, komi: 0 })
  assert.equal(est.cells[1 * size + 1], 2, '死黑子画白方块')
  assert.equal(est.cells[3 * size + 3], 1, '死白子画黑方块')
  assert.equal(est.deadBlack, 1)
  assert.equal(est.deadWhite, 1)
  // 死子所在的点算对方的「地」；活子算自己的「子」
  assert.equal(est.blackPoints, 0 + 1, '黑：活子 0 + 地 1（死白子那点）')
  assert.equal(est.whitePoints, 0 + 1)

  // 自己人手里的棋子不画方块（棋子自己就是棋子，叠方块只会糊）
  const alive = new Array(size * size).fill(0.9)
  const est2 = estimateTerritory(board, size, { ownership: alive, komi: 0 })
  assert.equal(est2.cells[1 * size + 1], 0, '活黑子上不叠方块')
  assert.equal(est2.blackAlive, 1, '活黑子只有那一颗（白子被判死，算黑的地）')
  assert.equal(est2.deadWhite, 1)
})

test('territory: 数子法计分与领先（贴目算给白方）', () => {
  const size = 5
  const board = emptyBoard(size)
  for (let x = 0; x < size; x++) board[0 * size + x] = 1 // 顶边一排黑子（5 颗）
  const ownership = new Array(size * size).fill(0.9)
  const est = estimateTerritory(board, size, { ownership, komi: 7.5 })
  assert.equal(est.blackAlive, 5)
  assert.equal(est.blackTerritory, size * size - 5, '其余空点全是黑的')
  assert.equal(est.blackPoints, size * size)
  assert.equal(est.whitePoints, 0)
  assert.equal(est.lead, size * size - 7.5, '黑目 − 白目 − 贴目')
  assert.equal(territoryScoreText(est), '形势判断：黑 25 目 · 白 0 目（含贴目 7.5）· 黑领先 17.5 目')

  const even = estimateTerritory(emptyBoard(3), 3, { ownership: new Array(9).fill(0), komi: 0 })
  assert.equal(even.lead, 0)
  assert.equal(territoryScoreText(even), '形势判断：黑 0 目 · 白 0 目（不贴目）· 双方持平')
  assert.equal(territoryScoreText(null), '', '没有数据时不编一句话')
})

test('territory: 输入不合法时返回 null（长度不符 / 缺归属图）', () => {
  const size = 5
  assert.equal(estimateTerritory(emptyBoard(size), size, {}), null, '没有归属图')
  assert.equal(estimateTerritory(emptyBoard(size), size, { ownership: [1, 2, 3] }), null, '长度不符')
  assert.equal(estimateTerritory(null, size, { ownership: new Array(size * size).fill(0) }), null, '没有盘面')
  assert.equal(cellsFromOwnership(emptyBoard(size), size, null), null)
  assert.equal(scoreFromCells(emptyBoard(size), size, null), null)
})

test('territory: 三档图的打包/解包（写进 TP[] 的那串）', () => {
  const cells = new Uint8Array(81)
  cells[0] = 1
  cells[1] = 2
  cells[80] = 1
  const packed = packTerritory(cells)
  assert.equal(typeof packed, 'string')
  assert.ok(packed.length <= Math.ceil(81 / 4 / 3) * 4 + 4, '紧凑：2 bit/点，base64')
  assert.ok(!/[^A-Za-z0-9+/=]/.test(packed), 'base64 里没有会被 SGF 吃掉的结构字符')
  const back = unpackTerritory(packed, 81)
  assert.equal(back[0], 1)
  assert.equal(back[1], 2)
  assert.equal(back[80], 1)
  assert.equal(back[40], 0)
  assert.equal(unpackTerritory('', 81), null)
  assert.equal(unpackTerritory('!!!', 81), null, '不是 base64 就当解析失败')
  assert.equal(unpackTerritory(packed, 19 * 19), null, '长度不够就解不出来（不猜）')
})

test('territory: 重放器算提子，逐手形势判断与手顺对齐', () => {
  const size = 5
  // 白在 (0,0)，只有 (1,0) 一口气；黑下 (1,0) 把它提掉
  const compact = {
    size,
    komi: 0,
    setup: { black: [[0, 1]], white: [[0, 0]] },
    moves: [
      { c: 'B', x: 1, y: 0 }, // 收气：白 (0,0) 无气被提
      { c: 'W', x: 4, y: 4 },
    ],
  }
  const replay = replayTo(compact, 1)
  assert.equal(replay.capturedWhite, 1, '白方被提 1 子')
  assert.equal(replay.capturedBlack, 0)
  assert.equal(replay.board[0], 0, '被提的子从盘上消失')
  assert.equal(replayTo(compact, 0).board[0], 2, '第 0 手（开局）时它还在')

  const ownership = new Array(size * size).fill(0.9)
  const series = estimateTerritorySeries(compact, [ownership, null])
  assert.equal(series.length, 2, '与手顺等长')
  assert.ok(series[0] !== null && typeof series[0].packed === 'string')
  assert.equal(series[1], null, '该手没有归属数据 → null（客户端据此不画）')
  assert.equal(series[0].est.capturedWhite, 1, '数字里带上提子')
  assert.equal(unpackTerritory(series[0].packed, size * size)[0], 1, '全盘判黑时起点是黑地')

  const replayer = createReplayer(compact)
  replayer.step(replayer.moves[0])
  assert.equal(replayer.captures().capturedWhite, 1)
})
