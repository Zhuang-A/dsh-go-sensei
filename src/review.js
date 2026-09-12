// src/review.js — 问题手识别（复盘核心）
//
// 消费 parseGame 的产物：以"落子者视角"的胜率/目差在相邻手之间的落差
// 标记问题手。阈值可配置（默认胜率 3% 或目差 3 目，对应 KataGo 失误线）。
// 无任何分析数据时降级为 theory 模式（纯棋理讲解）。

import { winrateForColor, scoreForColor, coordLabel, kataCoordLabel, kataCoordList } from './sgf.js'

/** 问题手分级（胜率落差从小到大）。 */
export const LABELS = [
  { key: 'inaccuracy', label: '不精确', minWinrateDelta: 0.03 },
  { key: 'mistake', label: '失误', minWinrateDelta: 0.08 },
  { key: 'blunder', label: '大恶手', minWinrateDelta: 0.2 },
]

/** 每级默认目差门槛（与胜率阈值独立，任一通道触发即标记）。 */
export const SCORE_DELTA_BY_LABEL = {
  inaccuracy: 2,
  mistake: 5,
  blunder: 10,
}

export const SEVERITY_ORDER = { blunder: 0, mistake: 1, inaccuracy: 2 }

/**
 * 四舍五入到 1 位小数；NaN/undefined 返回 undefined。
 *
 * **必须把 -0 归一成 0**：`Math.round(-0.2)` 返回 `-0`，于是
 * `round1(-0.02)` 也是 `-0`。而 DSH 的 lossless-JSON 边界
 * （@deepseek-ai/dsh-util-values 的 walkJsonValue）明确拒收 `-0`
 * （`!Number.isFinite(v) || Object.is(v, -0)` → 非法），整次工具调用会以
 * "value is not lossless JSON" 失败。真实触发场景：一手棋落子后胜率几乎没降
 * （wBefore - wAfter ≈ -0.0002），但目差掉够阈值 → 该候选被收录，
 * winrateLoss 带着 -0 出门，go_review_moves / go_engine_analyze 双双报错。
 * 见 test/review.test.mjs 的 "-0" 回归用例。
 */
export function round1(n) {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return undefined
  const r = Math.round(Number(n) * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

/**
 * 按胜率落差分级。
 * @param {number} winrateLoss 落子者视角胜率下降值（正数）
 * @returns {{ key: string, label: string } | null} 低于最低阈值返回 null
 */
export function classify(winrateLoss) {
  for (let i = LABELS.length - 1; i >= 0; i--) {
    if (winrateLoss >= LABELS[i].minWinrateDelta) return LABELS[i]
  }
  return null
}

function severityRank(c) {
  return SEVERITY_ORDER[c.label?.key] ?? 99
}

/**
 * 识别问题手候选。
 * @param {object} game parseGame 的返回值
 * @param {object} [opts]
 * @param {number} [opts.winrateThreshold=0.03] 胜率落差阈值（落子者视角，0~1）
 * @param {number} [opts.scoreThreshold=3] 目差阈值（目）
 * @param {number} [opts.pvDepth=6] 每候选保留的 PV 手数
 * @param {number} [opts.maxPvCandidates=3] 每手保留的候选点数
 * @param {number} [opts.minMove=1] 从第几手开始检视
 * @param {number} [opts.maxCandidates=30] 返回候选上限（按严重度截断）
 * @returns {{ mode: 'analysis'|'theory', candidates: object[], summary: object }}
 */
export function reviewGame(game, opts = {}) {
  const {
    winrateThreshold = 0.03,
    scoreThreshold = 3,
    pvDepth = 6,
    maxPvCandidates = 3,
    minMove = 1,
    maxCandidates = 30,
  } = opts

  const moves = game.moves ?? []
  const candidates = []
  let analyzedMoves = 0
  let lastMoveNumber = 0

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]
    lastMoveNumber = Math.max(lastMoveNumber, move.number)
    if (move.number < minMove || move.pass) continue

    const prev = i > 0 ? moves[i - 1] : undefined
    // 节点分析描述"落子后"局面：落子前 = 上一手节点，落子后 = 本手节点，均取落子者视角
    const wBefore = prev ? winrateForColor(prev, move.color) : undefined
    const wAfter = winrateForColor(move, move.color)
    const sBefore = prev ? scoreForColor(prev, move.color) : undefined
    const sAfter = scoreForColor(move, move.color)
    if (wBefore !== undefined && wAfter !== undefined) analyzedMoves += 1

    // winrateLoss 以百分点计（27.5 = 27.5%），一位小数；scoreLoss 以目计
    const winrateLoss = wBefore !== undefined && wAfter !== undefined ? round1((wBefore - wAfter) * 100) : undefined
    const scoreLoss = sBefore !== undefined && sAfter !== undefined ? round1(sBefore - sAfter) : undefined
    const winrateHit = winrateLoss !== undefined && winrateLoss / 100 >= winrateThreshold
    const scoreHit = scoreLoss !== undefined && scoreLoss >= scoreThreshold
    if (!winrateHit && !scoreHit) continue

    const label = classify((winrateLoss ?? 0) / 100) ?? classify((scoreLoss ?? 0) / 100)
    const analysis = move.analysis ?? {}
    // 候选点取**上一手节点**的分析：那里的行棋方正是本手落子者，
    // 所以它回答的是"第 N 手改下 X 会怎样"，且胜率天然是落子者自己视角
    // （LZ 约定：节点候选的 winrate 记该节点行棋方）。
    // 旧实现取本手节点，得到的是"这手之后的对手应手"，与工具描述（改下 X）不符。
    // 对拍见 review-check/_compare-lz-kata.mjs。
    const options = prev?.analysis ?? {}

    candidates.push({
      moveNumber: move.number,
      color: move.color,
      coord: move.coord,
      coordLabel: move.coord ? coordLabel(move.coord, game.info?.size ?? 19).label : null,
      label: label ? { key: label.key, label: label.label } : { key: 'inaccuracy', label: '值得注意' },
      winrateLoss,
      scoreLoss,
      winrateBefore: wBefore !== undefined ? round1(wBefore * 100) : undefined,
      winrateAfter: wAfter !== undefined ? round1(wAfter * 100) : undefined,
      scoreBefore: sBefore,
      scoreAfter: sAfter,
      pv: trimCandidates(options.lz?.candidates ?? options.candidates, pvDepth, maxPvCandidates, game.info?.size ?? 19),
      engine: analysis.lz?.engine ?? analysis.commentAnalysis?.engine,
      playouts: analysis.lz?.playouts ?? analysis.commentAnalysis?.playouts,
      comment: typeof analysis.comment === 'string' ? analysis.comment.slice(0, 300) : undefined,
    })
  }

  candidates.sort((a, b) => {
    const d = severityRank(a) - severityRank(b)
    if (d !== 0) return d
    return (b.winrateLoss ?? 0) - (a.winrateLoss ?? 0)
  })

  const mode = analyzedMoves > 0 ? 'analysis' : 'theory'
  const summary = {
    mode,
    totalMoves: lastMoveNumber,
    analyzedMoves,
    candidatesCount: candidates.length,
    size: game.info?.size,
    komi: game.info?.komi,
    handicap: game.info?.handicap,
    result: game.info?.result,
    players: game.info?.players,
  }
  return { mode, candidates: candidates.slice(0, maxCandidates), summary }
}

/**
 * 裁剪候选点：每手至多 maxCandidates 个、PV 截断至 depth 手、
 * KataGo 风格坐标（R16）转人类标签。
 */
function trimCandidates(raw, depth, maxCandidates, size) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw.slice(0, maxCandidates).map((c) => ({
    coord: c.coord,
    label: kataCoordLabel(c.coord, size).label,
    visits: c.visits,
    winratePct: c.winratePer10000 !== undefined ? round1(c.winratePer10000 / 100) : undefined,
    scoreMean: c.scoreMean,
    pv: kataCoordList((c.pv ?? []).slice(0, depth), size),
  }))
}

/**
 * 水平标签（配置与提示词共用）：'auto' 或 18K..1K / 1D..9D。
 */
export function buildRankList() {
  const ranks = []
  for (let k = 18; k >= 1; k--) ranks.push(`${k}K`)
  for (let d = 1; d <= 9; d++) ranks.push(`${d}D`)
  return ranks
}

export const RANKS = buildRankList()

/**
 * 解析棋手段位为难度档位（供 'auto' 水平自适应）。
 * @param {string|undefined} rank 形如 '18级'、'18k'、'3D'、'野狐3段' 等
 * @returns {string|undefined} 规范化后的段位（如 '18K' / '3D'）
 */
export function normalizeRank(rank) {
  if (typeof rank !== 'string' || rank === '') return undefined
  const m = /(\d{1,2})\s*(?:级|k|K)/.exec(rank)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 1 && n <= 30) return `${Math.min(n, 18)}K`
  }
  const d = /(\d{1,2})\s*(?:段|d|D)/.exec(rank)
  if (d) {
    const n = parseInt(d[1], 10)
    if (n >= 1 && n <= 9) return `${n}D`
  }
  return undefined
}

/**
 * 从棋局双方段位推断讲解难度（'auto' 模式）。双方可解析时取较低一方（更照顾初学者）。
 * @param {object} info parseGame 的 info
 * @returns {string} RANKS 之一，或 'auto'（无法推断）
 */
export function inferLevel(info) {
  const a = normalizeRank(info?.players?.blackRank)
  const b = normalizeRank(info?.players?.whiteRank)
  if (!a && !b) return 'auto'
  const pick = [a, b].filter(Boolean).sort((x, y) => RANKS.indexOf(x) - RANKS.indexOf(y))[0]
  return pick
}
