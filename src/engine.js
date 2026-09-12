// src/engine.js — KataGo kata-analyze 补算通道
//
// 通过 ctx.subprocess.spawn 启动本地 KataGo analysis 模式：
// 重放棋谱至目标区间，发 kata-analyze interval 查询，解析 JSON 响应，
// 产出与 LZ 属性同一约定（胜率=黑方视角、scoreLeadWhite=白方领先）的分析
// 数据，再交给 reviewGame 复用同一套问题手识别。

import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { reviewGame } from './review.js'

const COLLECT_BYTES = 64 * 1024 * 1024
const GRACE_MS = 15000

function sgfToKataCoord(coord, size) {
  if (coord === null || coord === undefined) return 'pass'
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const x = alphabet.indexOf(coord[0])
  const y = alphabet.indexOf(coord[1])
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  return `${letters[x]}${size - y}`
}

// 19 路标准让子摆点（x 自左、y 自下、0 起）
const HANDICAP_POINTS = {
  2: [[3, 3], [15, 15]],
  3: [[3, 3], [15, 15], [3, 15]],
  4: [[3, 3], [15, 15], [3, 15], [15, 3]],
  5: [[3, 3], [15, 15], [3, 15], [15, 3], [9, 9]],
  6: [[3, 3], [9, 3], [15, 3], [3, 15], [9, 15], [15, 15]],
  7: [[3, 3], [9, 3], [15, 3], [3, 15], [9, 15], [15, 15], [9, 9]],
  8: [[3, 3], [9, 3], [15, 3], [3, 9], [15, 9], [3, 15], [9, 15], [15, 15]],
  9: [[3, 3], [9, 3], [15, 3], [3, 9], [15, 9], [3, 15], [9, 15], [15, 15], [9, 9]],
}

function xyToKataCoord(x, y, size) {
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  return `${letters[x]}${size - y}`
}

/**
 * 生成 KataGo analysis 引擎的 JSON 查询（v1.14+ 默认 JSON 协议）。
 * @param {object} game parseGame 返回值
 * @param {number} from 补算起始手
 * @param {number} to 补算结束手
 * @param {number} maxVisits 每手搜索量
 * @returns {string} 单行 JSON 查询（含结尾换行）
 */
export function buildKataJsonQuery(game, from, to, maxVisits) {
  const info = game.info
  const query = {
    id: 'go-sensei',
    rules: (info.rule ?? '').toLowerCase().includes('japan') ? 'japanese' : 'chinese',
    komi: normalizeKomi(info.komi),
    boardXSize: info.size,
    boardYSize: info.size,
    moves: [],
    analyzeTurns: [],
    maxVisits,
  }
  const handicap = info.handicap ?? 0
  const offset = handicap >= 2 ? handicap - 1 : 0
  let start = 0
  if (handicap >= 2) {
    const points = HANDICAP_POINTS[handicap]
    if (!points) throw new Error(`暂不支持让 ${handicap} 子的补算（支持 2~9 子）`)
    query.initialStones = points.map(([x, y]) => ['B', xyToKataCoord(x, y, info.size)])
    query.initialPlayer = 'W'
    start = offset // SGF 前 N-1 手即摆子，从白方第一手开始重放
  }
  const moves = game.moves
  const replayUntil = Math.min(to, moves.length)
  for (let i = start; i < replayUntil; i++) {
    const m = moves[i]
    query.moves.push([m.color, m.pass ? 'pass' : sgfToKataCoord(m.coord, info.size)])
  }
  // turn N = 重放序列中第 N 手之后的局面；SGF 手数 = turn + offset
  const turnFrom = Math.max(1, from - offset)
  const turnTo = to - offset
  if (turnTo < 1) throw new Error('补算区间全部位于让子摆子内，请从实际落子手开始')
  for (let t = turnFrom; t <= turnTo && t <= moves.length - offset; t++) query.analyzeTurns.push(t)
  return JSON.stringify(query) + '\n'
}

/**
 * 把 SGF 的贴目规整成 KataGo analysis 能接受的取值。
 *
 * KataGo 对 `komi` 的要求是**整数或半整数**且落在 [-150, 150]，否则整条查询被拒：
 *   {"error":"Must be a integer or half-integer from -150.0 to 150.0","field":"rules","id":...}
 * 注意该报错把 field 写成 "rules"（实测 KataGo v1.16.4），极易误判成规则字符串问题。
 *
 * 现实里会拿到非半整数：旧式/异常 SGF 的百分制贴目（KM[375]）经解析归一化后可能
 * 得到 3.75 这类值。这里就近吸附到 0.5 的整数倍并夹到合法区间，保证查询可用。
 * 吸附幅度会原样写入返回值，调用方无需额外处理。
 *
 * @param {number|undefined} komi SGF 解析出的贴目
 * @returns {number} 合法的整数/半整数贴目
 */
export function normalizeKomi(komi) {
  const n = Number(komi)
  if (!Number.isFinite(n)) return 7.5 // 未记录贴目时的通用默认（中国规则）
  const snapped = Math.round(n * 2) / 2
  return Math.max(-150, Math.min(150, snapped))
}

/**
 * 从引擎输出里提取错误/告警行文本，用于在补算无结果时给出可诊断的原因。
 * 每行形如 {"error":"...","field":"...","id":"..."} 或 {"warning":...}。
 * @param {string} stdout 引擎 stdout
 * @returns {string|undefined} 前若干条错误信息（用 '; ' 连接），无错误返回 undefined
 */
export function extractKataErrors(stdout) {
  const messages = []
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj && typeof obj.error === 'string') {
      messages.push(obj.field ? `${obj.error}（field=${obj.field}）` : obj.error)
    }
  }
  return messages.length > 0 ? [...new Set(messages)].slice(0, 3).join('; ') : undefined
}

/**
 * 解析 kata-analyze 的 JSON 行输出，合并为每手的候选着法列表。
 *
 * 每个 turn 可能有多个响应（增量更新）：按 order 合并，同一 order 以更完整
 * （visits 更多）的条目为准。
 *
 * @param {string} stdout 引擎输出
 * @returns {Map<number, object[]>} turnNumber(1-based) -> 按 order 升序的 moveInfo 数组
 */
export function parseKataAnalysisOutput(stdout) {
  /** turn -> Map<order, moveInfo> */
  const byMove = new Map()
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!obj || !Array.isArray(obj.moveInfos)) continue
    // turnNumber 通常在响应顶层（每 turn 一个响应）；兼容位于 moveInfo 内的旧形态
    const responseTurn = obj.turnNumber
    for (const mi of obj.moveInfos) {
      if (!mi || typeof mi.move !== 'string') continue
      if (mi.move === 'pass' || mi.move === 'resign') continue
      const turnNumber = mi.turnNumber ?? responseTurn
      if (turnNumber === null || turnNumber === undefined) continue
      let byOrder = byMove.get(turnNumber)
      if (byOrder === undefined) {
        byOrder = new Map()
        byMove.set(turnNumber, byOrder)
      }
      const order = mi.order ?? 99
      const existing = byOrder.get(order)
      if (existing === undefined || (mi.visits ?? 0) >= (existing.visits ?? 0)) {
        byOrder.set(order, mi)
      }
    }
  }
  // 展开为按 order 升序的数组
  const out = new Map()
  for (const [turn, byOrder] of byMove) {
    out.set(turn, [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, mi]) => mi))
  }
  return out
}

/**
 * 从一个 turn 的候选着法列表构造 LZ 同约定的候选数组（供 reviewGame 消费）。
 * @param {object[]} moveInfos 该 turn 的 moveInfo（按 order 升序）
 * @param {number} maxCandidates 保留的候选数上限
 * @param {{ winrateFrame?: 'black'|'mover', moveColor?: 'B'|'W' }} [opts]
 *   winrateFrame = 引擎输出口径；moveColor = 该 turn 刚落子的一方（用于推出该 turn 的行棋方）
 * @returns {object[]} { coord, visits, winratePer10000, scoreMean, pv }
 */
function toLzCandidates(moveInfos, maxCandidates = 3, opts = {}) {
  const frame = opts.winrateFrame === 'mover' ? 'mover' : 'black'
  // 该 turn 的行棋方 = 刚落子者的对手。LZ 约定里候选点的 winrate 记的是**该行棋方**视角
  // （实测：real-analysis.sgf 第 21 手节点头部黑方 1.1%，其首选候选 F16 记 98.9%，
  //  即该节点行棋方白方的胜率）。故引擎的固定黑方口径必须换算，否则同一手棋旁边
  // 「头部落差（落子者视角）」与「候选百分比」是两个口径。
  // 见 review-check/_compare-lz-kata.mjs。
  const toMove = opts.moveColor === 'B' ? 'W' : 'B'
  /** 引擎口径 → 该 turn 行棋方视角 */
  const toCandidateView = (w) => {
    if (w === undefined) return undefined
    if (frame === 'mover') return w // 引擎已按行棋方（SELF）输出
    return toMove === 'B' ? w : 1 - w // 引擎按固定黑方输出
  }
  const out = []
  for (const mi of moveInfos) {
    const pvMoves = Array.isArray(mi.pv) ? mi.pv.filter((p) => typeof p === 'string') : []
    const coord = typeof mi.move === 'string' ? mi.move : pvMoves[0]
    if (coord === undefined || coord === 'pass' || coord === 'resign') continue
    const w = toCandidateView(mi.winrate)
    out.push({
      coord,
      visits: mi.visits ?? 0,
      winratePer10000: w !== undefined ? Math.round(w * 10000) : 0,
      scoreMean: mi.scoreMean,
      pv: pvMoves.length > 0 ? pvMoves : [coord],
    })
    if (out.length >= maxCandidates) break
  }
  return out
}

/**
 * 把 KataGo moveInfo 转成与 LZ 属性同约定的分析对象。
 *
 * **口径（frame）是关键**：引擎输出的 winrate 视角由 analysis 配置的
 * `reportAnalysisWinratesAs` 决定（实测本机 analysis_example.cfg 设为 BLACK）。
 * 所以必须先问清楚口径，再换算成 LZ 约定（= analysis.lz.winratePct 存
 * 落子者视角，随后由 winrateForMover 直接采用，不再取反）。
 *
 * 判定实验（黑白互换同一局面，两局行棋方都是黑）：
 *   A 黑20子压白2子 → rootInfo.winrate = 1.0000
 *   B 同局面黑白互换 → rootInfo.winrate = 0.0001
 * 两局行棋方相同、结果悬殊 ⇒ 输出是**固定黑方视角**，不是行棋方视角。
 *
 * @param {object} mi KataGo moveInfo（mi.winrate 为 blackWinrate）
 * @param {'B'|'W'} moveColor 该手颜色（= 落子者）
 * @param {{ winrateFrame: 'black'|'mover' }} [opts] 引擎输出口径
 */
function toLzLikeAnalysis(mi, moveColor, opts = {}) {
  const frame = opts.winrateFrame === 'mover' ? 'mover' : 'black'
  // 引擎口径 → 落子者视角：
  //   frame='black'：mi.winrate 是黑方胜率，落子方为白时才取反；
  //   frame='mover'：mi.winrate 是该 turn 行棋方（= 落子者的**对手**）的胜率，一律取反。
  // 旧实现把 'mover' 也当黑方口径先取反一次、再按 moveColor 取反，等于对白方每一手
  // 取反两次 → 白方胜率被算回黑方视角。该分支只在配置未写 reportAnalysisWinratesAs
  // 时命中（本机配置写死 BLACK，故长期未暴露）。
  const moverWinrate = mi.winrate === undefined
    ? undefined
    : frame === 'mover'
      ? 1 - mi.winrate
      : (moveColor === 'B' ? mi.winrate : 1 - mi.winrate)
  const lz = {
    engine: 'KataGo',
    winratePct: moverWinrate !== undefined ? Math.round(moverWinrate * 1000) / 10 : undefined,
    playouts: String(mi.visits ?? ''),
  }
  if (mi.scoreMean !== undefined) {
    // scoreMean 与 winrate 同口径：黑方视角领先 → 换成对手视角
    lz.scoreLeadOpponent = moveColor === 'B' ? -mi.scoreMean : mi.scoreMean
  }
  if (mi.scoreStdev !== undefined) lz.stdev = mi.scoreStdev
  return { lz }
}

/**
 * 从 analysis 配置文本读取胜率口径。
 *
 * KataGo analysis 的 `reportAnalysisWinratesAs` 决定 winrate 的视角：
 *   BLACK  → 固定黑方视角（本机 analysis_example.cfg 的实测取值）
 *   SELF   → 行棋方视角
 *   WHITE  → 固定白方视角
 * 未设置时 KataGo 默认 SELF。参数可能写在命令行 override 里，故一并接受。
 *
 * @param {string} configText 配置文件原文（可为空）
 * @param {string} [override] 命令行 -override-config 片段（可选）
 * @returns {'black'|'mover'} 归一化口径（WHITE 按 mover 之外的固定视角处理见下）
 */
export function readWinrateFrame(configText, override) {
  const pick = (text) => {
    if (typeof text !== 'string' || text === '') return undefined
    const m = /reportAnalysisWinratesAs\s*[=:]\s*([A-Za-z]+)/.exec(text)
    return m ? m[1].toUpperCase() : undefined
  }
  const value = pick(override) ?? pick(configText)
  if (value === undefined) return 'mover' // KataGo 默认 SELF
  if (value === 'BLACK') return 'black'
  return 'mover'
}

/**
 * 运行 KataGo 补算。
 * @param {(spec: object) => object} spawn ctx.subprocess.spawn 的绑定函数
 * @param {object} opts
 * @param {string} opts.kataGoPath 引擎可执行文件
 * @param {string} [opts.configPath] 配置文件（可为空串，KataGo 自带默认）
 * @param {string} [opts.modelPath] 权重文件（可为空串，取配置内 modelFile）
 * @param {object} opts.game parseGame 返回值
 * @param {number} opts.from 补算起始手
 * @param {number} opts.to 补算结束手
 * @param {number} opts.maxVisits 每手搜索量
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ engine: string, moves: number, seconds: number, candidates: object[] }>}
 */
export async function runKataAnalyze(spawn, opts) {
  const { kataGoPath, configPath, modelPath, game, from, to, maxVisits, signal } = opts
  const argv = [kataGoPath, 'analysis']
  if (configPath) argv.push('-config', configPath)
  if (modelPath) argv.push('-model', modelPath)
  // analysis 模式必需键补齐（GTP 配置文件常缺 numAnalysisThreads）
  argv.push('-override-config', 'numAnalysisThreads=1')
  const queries = buildKataJsonQuery(game, from, to, maxVisits)
  const started = Date.now()
  const handle = spawn({
    argv,
    cwd: dirname(kataGoPath),
    stdio: {
      stdin: { data: queries },
      stdout: { maxBytes: COLLECT_BYTES, spill: { maxBytes: COLLECT_BYTES } },
      stderr: { maxBytes: COLLECT_BYTES, spill: { maxBytes: COLLECT_BYTES } },
    },
    graceMs: GRACE_MS,
    ...(signal !== undefined ? { signal } : {}),
  })
  const outcome = await handle.done
  const seconds = Math.round((Date.now() - started) / 1000)
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    const tail = stderr.split('\n').filter((l) => l.trim() !== '').slice(-6).join('\n')
    throw new Error(`KataGo 退出码 ${outcome.exitCode}：${tail || '无错误输出'}`)
  }

  const byMove = parseKataAnalysisOutput(stdout)
  // 引擎可能对每条查询都回错误行（{"error":...,"field":...,"id":...}）而进程仍以 0 退出。
  // 此时 byMove 为空：绝不能当作"补算成功但没有问题手"上报，否则用户会以为局面很干净。
  if (byMove.size === 0) {
    const engineError = extractKataErrors(stdout)
    if (engineError) {
      throw new Error(
        `KataGo 拒绝了补算查询：${engineError}（请检查贴目是否为整数/半整数、规则字符串是否为 chinese/japanese 等）`,
      )
    }
  }
  // turn -> SGF 手数映射（让子棋谱前 N-1 手是摆子，turn 与 SGF 手数差 offset）
  const handicap = game.info?.handicap ?? 0
  const offset = handicap >= 2 ? handicap - 1 : 0
  // 胜率口径：由 analysis 配置的 reportAnalysisWinratesAs 决定（见 readWinrateFrame）。
  // 读不到配置文件文本时按 KataGo 默认（SELF = 行棋方视角）。
  let frame = 'mover'
  try {
    const configText = configPath ? readFileSync(configPath, 'utf8') : ''
    frame = readWinrateFrame(configText, undefined)
  } catch {
    frame = 'mover'
  }
  // 合成分析数据并复用 reviewGame 的问题手识别
  const merged = { ...game, moves: game.moves.map((m) => ({ ...m })) }
  for (const [turnNumber, moveInfos] of byMove) {
    const idx = turnNumber - 1 + offset
    if (idx < 0 || idx >= merged.moves.length) continue
    const move = merged.moves[idx]
    // move.color = 该手落子者；口径换算必须知道它（见 toLzLikeAnalysis）
    const analysis = toLzLikeAnalysis(moveInfos[0], move.color, { winrateFrame: frame })
    // 候选来自该 turn 的全部 moveInfos（按 order 升序），而非仅有最优那一手 ——
    // 这样补算结果与消费带分析棋谱时的「每手 ≤3 候选」形态一致。
    // 口径必须与该 turn 的行棋方一致（move.color 是刚落子者），见 toLzCandidates。
    analysis.lz.candidates = toLzCandidates(moveInfos, 3, { winrateFrame: frame, moveColor: move.color })
    move.analysis = analysis
  }

  const review = reviewGame(merged, {
    winrateThreshold: 0.03,
    scoreThreshold: 3,
    pvDepth: 6,
    maxPvCandidates: 3,
    minMove: from,
    maxCandidates: 50,
  })
  return {
    engine: 'KataGo',
    moves: byMove.size,
    seconds,
    /**
     * 已把补算分析合成进 moves 的棋局副本。
     * 供调用方（如 go_review_moves 的自动补算）直接复用，避免同一逻辑写两份。
     */
    merge: merged,
    candidates: review.candidates.map((c) => ({
      moveNumber: c.moveNumber,
      color: c.color,
      coord: c.coord,
      coordLabel: c.coordLabel,
      label: c.label,
      winrateLoss: c.winrateLoss,
      scoreLoss: c.scoreLoss,
      pv: c.pv,
    })),
  }
}
