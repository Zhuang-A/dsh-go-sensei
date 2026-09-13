// test/review.test.mjs — review.js 单测（问题手识别 / 阈值 / 理论模式 / 让子）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGame, decodeBuffer } from '../src/sgf.js'
import {
  reviewGame,
  classify,
  round1,
  normalizeRank,
  inferLevel,
  aiCandidatesAtMove,
  aiCandidatesByMove,
  RANKS,
} from '../src/review.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const loadGame = (name) => {
  const buf = readFileSync(fixture(name))
  const { text } = decodeBuffer(buf)
  return parseGame(text)
}

test('classify: 分级阈值', () => {
  assert.equal(classify(0.01), null)
  assert.equal(classify(0.03).key, 'inaccuracy')
  assert.equal(classify(0.079).key, 'inaccuracy')
  assert.equal(classify(0.08).key, 'mistake')
  assert.equal(classify(0.19).key, 'mistake')
  assert.equal(classify(0.2).key, 'blunder')
})

test('round1: 一位小数', () => {
  assert.equal(round1(0.275), 0.3)
  assert.equal(round1(3.14159), 3.1)
  assert.equal(round1(undefined), undefined)
})

// 回归：Math.round(-0.2) === -0，若原样返回会让工具返回值为非法 lossless JSON，
// go_review_moves / go_engine_analyze 在**有引擎数据**时整次调用报
// "value is not lossless JSON"（纯棋谱路径反而正常，故极易漏检）。
test('round1: 归一 -0（-0 不是合法 lossless JSON）', () => {
  assert.ok(Object.is(Math.round(-0.2), -0), '前提：Math.round(-0.2) 确实是 -0')
  assert.ok(!Object.is(round1(-0.02), -0), 'round1 不得返回 -0')
  assert.equal(round1(-0.02), 0)
  assert.equal(round1(-0.04), 0)
  assert.equal(round1(-0.5), -0.5, '真正的负数不能被抹平')
  assert.equal(round1(NaN), undefined)
  assert.equal(round1(Infinity), undefined)
})

// 回归：胜率几乎没降（-0.02 个百分点）但目差掉够阈值时，候选会被收录，
// winrateLoss 必须是 0 而不是 -0 —— 这正是真机上报 invalid output 的形态。
test('reviewGame: 只靠目差命中时 winrateLoss 不得为 -0', () => {
  const mk = (number, color, winratePct, scoreLeadBlack) => ({
    number,
    color,
    coord: number === 1 ? 'qd' : 'dd',
    pass: false,
    analysis: { scoreLeadBlack, lz: { winratePct, engine: 'KataGo', playouts: '100' } },
  })
  const game = {
    info: { size: 19, komi: 0, handicap: 0, result: 'B+0', players: {} },
    moves: [
      mk(1, 'B', 50.0, -5), // 黑落后 5 目；白方视角胜率 50.0%
      mk(2, 'W', 50.02, 5), // 白方视角胜率 50.02%（微升 0.02）→ 落差 -0.02 → round1(-0.2)
    ],
  }
  const { candidates } = reviewGame(game, { winrateThreshold: 0.03, scoreThreshold: 3 })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].moveNumber, 2)
  assert.ok(!Object.is(candidates[0].winrateLoss, -0), 'winrateLoss 不得为 -0')
  assert.equal(candidates[0].winrateLoss, 0)
  assert.equal(candidates[0].scoreLoss, 10) // 目差通道独立命中
})

test('reviewGame: 合成棋谱命中 3 个问题手且分级正确', () => {
  const game = loadGame('synthetic-analysis.sgf')
  const { mode, candidates, summary } = reviewGame(game)
  assert.equal(mode, 'analysis')
  assert.equal(summary.analyzedMoves, 7) // 第 1 手无前一局面，不计入
  assert.equal(candidates.length, 3)

  const byMove = new Map(candidates.map((c) => [c.moveNumber, c]))
  // 第 4 手 W dd：白方胜率 49.5% -> 22%，-27.5 大恶手
  const m4 = byMove.get(4)
  assert.equal(m4.label.key, 'blunder')
  assert.equal(m4.winrateLoss, 27.5)
  assert.equal(m4.scoreLoss, 27.5)
  // 第 6 手 W nc：白方 21% -> 13%，-8 失误（仅 LZ 通道）
  const m6 = byMove.get(6)
  assert.equal(m6.label.key, 'mistake')
  assert.equal(m6.winrateLoss, 8)
  // 第 8 手 W dq：白方 13.5% -> 10%，-3.5 不精确
  const m8 = byMove.get(8)
  assert.equal(m8.label.key, 'inaccuracy')
  assert.equal(m8.winrateLoss, 3.5)
  // 第 7 手黑 -0.5：低于阈值不标记
  assert.equal(byMove.has(7), false)
})

test('reviewGame: 候选按严重度排序且 PV 截断', () => {
  const game = loadGame('synthetic-analysis.sgf')
  const { candidates } = reviewGame(game, { pvDepth: 2, maxPvCandidates: 1 })
  assert.deepEqual(candidates.map((c) => c.moveNumber), [4, 6, 8])
  const m4 = candidates[0]
  assert.equal(m4.pv.length, 1)
  // 候选取「上一手节点」（第 3 手）的分析：那里的行棋方正是第 4 手的白方，
  // 也就是"第 4 手改下 X 会怎样"。旧实现取本手节点，得到的是对手应手 C17/N17。
  assert.equal(m4.pv[0].coord, 'D16')
  assert.equal(m4.pv[0].label, 'D16')
  assert.equal(m4.pv[0].pv, 'D16 D4') // 截断到 2 手
})

test('reviewGame: 自定义阈值可收紧候选', () => {
  const game = loadGame('synthetic-analysis.sgf')
  const { candidates } = reviewGame(game, { winrateThreshold: 0.05, scoreThreshold: 999 })
  assert.deepEqual(candidates.map((c) => c.moveNumber), [4, 6])
})

test('reviewGame: 目差通道独立触发', () => {
  const game = loadGame('synthetic-analysis.sgf')
  // 把胜率阈值拉满，仅靠目差（默认 3 目）也应命中 4/6/8
  const { candidates } = reviewGame(game, { winrateThreshold: 1 })
  assert.deepEqual(candidates.map((c) => c.moveNumber), [4, 6, 8])
})

test('reviewGame: 纯棋谱（无分析）降级 theory 模式', () => {
  const game = loadGame('[庄生梦1n4k]vs[V296646120]1788444401030026285.sgf')
  const { mode, candidates, summary } = reviewGame(game)
  assert.equal(mode, 'theory')
  assert.deepEqual(candidates, [])
  assert.equal(summary.analyzedMoves, 0)
  assert.ok(summary.totalMoves > 50)
})

// 回归：候选点必须是「落子者自己改下的着法 + 落子者自己视角」。
// 旧实现取本手节点 → 拿到的是对手应手，且引擎通道还是固定黑方口径（实测差 98.9%↔1.1%）。
test('reviewGame: 候选取上一手节点且为落子者视角（真实带分析棋谱）', () => {
  const game = loadGame('real-analysis.sgf')
  const { candidates } = reviewGame(game)
  const m21 = candidates.find((c) => c.moveNumber === 21)
  assert.ok(m21, '第 21 手（黑 F14）应被标记为问题手')
  assert.equal(m21.label.key, 'blunder')
  assert.equal(m21.winrateLoss, 98.8)
  // 第 20 手节点由黑行棋 → 候选是黑自己的选择：F16 99.9%、B14 53.4%、A14 15.4%
  assert.deepEqual(m21.pv.map((p) => p.label), ['F16', 'B14', 'A14'])
  assert.equal(m21.pv[0].winratePct, 99.9, '候选胜率必须是落子者（黑）自己视角')
  // 反向对照：本手节点（第 21 手）的候选是白方应手，其首选 F16 记 98.94%（白方视角，
  // 与头部「黑方 1.1%」互补），旧实现正是把这个数当成落子者视角直接输出。
  const own = game.moves[20].analysis.lz.candidates[0]
  assert.equal(own.coord, 'F16')
  assert.equal(own.winratePer10000, 9894)
})

// 面板要在**讲解点**上也标出 AI 首选与变化图，而讲解点未必是问题手：
// 逐手候选必须存在，且与 reviewGame 同一口径（取上一手节点）——
// 否则同一手会在列表里给一个首选点、在盘上给另一个。
test('aiCandidatesByMove: 逐手候选与 reviewGame 同源，且覆盖问题手之外的手', () => {
  const game = loadGame('real-analysis.sgf')

  // ① 与列表口径一致：第 21 手（问题手）两处给出的候选逐点相同
  const m21 = reviewGame(game).candidates.find((c) => c.moveNumber === 21)
  const ai21 = aiCandidatesAtMove(game, 21)
  assert.deepEqual(ai21.map((p) => p.label), m21.pv.map((p) => p.label))
  assert.equal(ai21[0].winratePct, 99.9, '候选胜率仍是落子者（黑）自己视角')
  assert.deepEqual(Object.keys(ai21[0]).sort(),
    ['coord', 'label', 'pv', 'scoreMean', 'visits', 'winratePct'])

  // ② 第 1 手前面没有节点、越界手数没有节点：都不得凭空造候选
  assert.equal(aiCandidatesAtMove(game, 1), undefined)
  assert.equal(aiCandidatesAtMove(game, 9999), undefined)
  assert.equal(aiCandidatesAtMove(parseGame('(;GM[1]FF[4]SZ[19])'), 1), undefined)

  // ③ 逐手表：手数 -> 候选，没有候选的手不占键
  const byMove = aiCandidatesByMove(game)
  const keys = Object.keys(byMove).map(Number)
  const problems = new Set(reviewGame(game, { maxCandidates: 999 }).candidates.map((c) => c.moveNumber))
  assert.equal(byMove['1'], undefined, '第 1 手不占键')
  assert.ok(keys.every((n) => n >= 2 && n <= game.moves.length), `手数越界：${keys.slice(0, 5)}`)
  assert.ok(keys.length > problems.size,
    `有候选的手应远多于问题手：${keys.length} vs ${problems.size}`)
  assert.ok(keys.some((n) => !problems.has(n)),
    '必须有不在问题手列表里的手 —— 讲解点正是靠这一份数据才有首选/变化图')
  for (const n of keys) {
    assert.ok(byMove[String(n)].length <= 3, `第 ${n} 手候选应裁剪到 ≤3`)
    assert.equal(typeof byMove[String(n)][0].label, 'string')
  }

  // ④ limit 是防御性上限（异常棋谱不把 payload 撑大）
  assert.equal(Object.keys(aiCandidatesByMove(game, { limit: 3 })).length, 3)
})

test('reviewGame: 让子棋谱（HA>0）theory 模式且信息完整', () => {
  const game = loadGame('[庄生梦1n4k]vs[鍾易成1]1788532348030034222.sgf')
  assert.equal(game.info.handicap, 1)
  const { mode, summary } = reviewGame(game)
  assert.equal(mode, 'theory')
  assert.equal(summary.handicap, 1)
  assert.equal(summary.result, 'W+R')
})

test('reviewGame: 空棋谱安全（无手）', () => {
  const game = parseGame('(;GM[1]FF[4]SZ[19]PB[a]PW[b])')
  const { mode, candidates, summary } = reviewGame(game)
  assert.equal(mode, 'theory')
  assert.deepEqual(candidates, [])
  assert.equal(summary.totalMoves, 0)
})

test('reviewGame: 虚着手不参与判定', () => {
  const game = loadGame('pass-game.sgf')
  const { candidates } = reviewGame(game)
  assert.equal(candidates.length, 0)
})

test('reviewGame: 真实带分析棋谱能产出候选且数据自洽', () => {
  const game = loadGame('real-analysis.sgf')
  const { mode, candidates, summary } = reviewGame(game)
  assert.equal(mode, 'analysis')
  assert.ok(summary.analyzedMoves >= summary.totalMoves * 0.5, `分析覆盖率应过半：${summary.analyzedMoves}/${summary.totalMoves}`)
  assert.ok(candidates.length >= 3, '109 手的对局应有若干问题手')
  for (const c of candidates) {
    assert.ok(c.moveNumber >= 1 && c.moveNumber <= summary.totalMoves)
    assert.ok(c.winrateLoss >= 0 || c.scoreLoss >= 0)
    assert.ok(c.label && c.label.label)
  }
})

test('normalizeRank: 各种段位写法', () => {
  assert.equal(normalizeRank('18级'), '18K')
  assert.equal(normalizeRank('18k'), '18K')
  assert.equal(normalizeRank('野狐启蒙级'), undefined)
  assert.equal(normalizeRank('3D'), '3D')
  assert.equal(normalizeRank('野狐9段'), '9D')
  assert.equal(normalizeRank('3d'), '3D')
})

test('inferLevel: 取双方较低水平', () => {
  const info = { players: { blackRank: '18级', whiteRank: '17级' } }
  assert.equal(inferLevel(info), '18K') // 18K 弱于 17K，取更弱一方
  assert.equal(inferLevel({ players: { blackRank: '3D', whiteRank: '1K' } }), '1K')
  assert.equal(inferLevel({ players: {} }), 'auto')
})

test('RANKS: 完整 18K..9D 序列', () => {
  assert.equal(RANKS.length, 27)
  assert.equal(RANKS[0], '18K')
  assert.equal(RANKS[RANKS.length - 1], '9D')
})
