// src/sgf.js — SGF 数据层
//
// 职责：
//  1. 编码自愈：UTF-8 严格解码失败回退 GBK；对"UTF-8 被按 GBK 误解码"的双重
//     mojibake 文本（野狐/部分国产导出器常见）尝试无损回修，回修不干净则保留原文。
//  2. 结构化解析：基于 @sabaki/sgf 解析主变化线，产出棋局信息 + 每手元数据。
//  3. 分析数据提取：支持 KataGo 风格属性（WV/DM/PV）与第三方 GUI 的
//     "Move N 胜率 (差值) (引擎 / 计算量)" 注释格式（其 SGFParser 不读 WV/DM，
//     只把分析写进 C[] 注释——实测源码确认）。
//  4. 注释回写：token 级扫描向主变化线指定手插入/合并 C[] 注释，除注入点外
//     保留原文件其余字节与格式；输出统一 UTF-8。

import sgf from '@sabaki/sgf'
import iconv from 'iconv-lite'
import { createReplayer, scoreFromCells, territoryScoreText, unpackTerritory } from './territory.js'

// ---------------------------------------------------------------------------
// 编码自愈
// ---------------------------------------------------------------------------

/**
 * 解码 SGF 字节流。优先严格 UTF-8；失败（原始 GBK 文件）回退 GBK。
 * @param {Uint8Array} buf 原始字节
 * @returns {{ text: string, encoding: 'utf-8' | 'gbk' }}
 */
export function decodeBuffer(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    return { text: iconv.decode(Buffer.from(buf), 'gbk'), encoding: 'gbk' }
  }
}

// 双重 mojibake 签名字符：UTF-8 汉字三字节序列被按 GBK 成对解释时落入的
// 低频区。真实中文名几乎不含这些字，故用作"疑似 mojibake"的必要条件。
const MOJIBAKE_SIGNATURE = /[搴勭敓姊绾渚濇棫鐐镐繛鍝閲庣嫄鍚閸炬槗鎴缁忕畻鎺у埗閰嶇疆鏂囦欢榛戞鐧芥鑳滅巼棰嗗厛璐寸洰涓嶇‘瀹氬害璁＄畻閲忕洰鎵嬬鏌ョ鏄仛鐨勬椂鍊?]/

/**
 * 对单个字符串（棋手名/棋局名等短字段）尝试回修双重 mojibake。
 * 仅当：原文含签名字符、GBK 回编码后 UTF-8 解码干净（无替换符/问号/希腊区字符）、
 * 且结果仍含汉字时才替换；否则保留原文（宁可显示乱码也不二次破坏）。
 * @param {string} value 原始字段文本
 * @returns {string} 回修后的文本（无法安全回修时原样返回）
 */
export function repairMojibakeField(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (!MOJIBAKE_SIGNATURE.test(value)) return value
  const bytes = iconv.encode(value, 'gbk')
  const repaired = iconv.decode(bytes, 'utf-8')
  if (repaired.length === 0) return value
  if (/[\ufffd?]/.test(repaired)) return value
  if (/[\u0370-\u03ff]/.test(repaired)) return value // GBK 字节按 UTF-8 解出的希腊/科普特区
  if (!/[\u4e00-\u9fff]/.test(repaired)) return value
  return repaired
}

// ---------------------------------------------------------------------------
// 坐标工具
// ---------------------------------------------------------------------------

const SGF_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * SGF 坐标转人类可读标签（如 'pd' -> 'Q16'，19 路）。
 * @param {string} coord SGF 坐标；'' 或 'tt'（19 路）视为虚着
 * @param {number} size 棋盘路数
 * @returns {{ label: string, pass: boolean, x: number, y: number }}
 */
export function coordLabel(coord, size = 19) {
  if (coord === '' || coord === 'tt') return { label: '虚着', pass: true, x: -1, y: -1 }
  const x = SGF_ALPHABET.indexOf(coord[0])
  const y = SGF_ALPHABET.indexOf(coord[1])
  if (x < 0 || y < 0 || x >= size || y >= size) return { label: coord, pass: false, x, y }
  const col = String.fromCharCode(65 + (x >= 8 ? x + 1 : x)) // 跳过 I
  const row = size - y
  return { label: `${col}${row}`, pass: false, x, y }
}

// 分析数据里的候选点坐标为「字母+行号」（如 R16、Q4），行号自下往上。
const KATA_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

/**
 * KataGo 风格坐标（如 'R16'）转标签与索引。
 * @param {string} coord KataGo 坐标
 * @param {number} size 棋盘路数
 * @returns {{ label: string, pass: boolean, x: number, y: number }}
 */
export function kataCoordLabel(coord, size = 19) {
  const m = /^([A-Za-z])(\d{1,2})$/.exec(coord ?? '')
  if (!m) return { label: coord ?? '', pass: false, x: -1, y: -1 }
  const x = KATA_COLUMNS.indexOf(m[1].toUpperCase())
  const row = parseInt(m[2], 10)
  const y = row >= 1 && row <= size ? size - row : -1
  return { label: `${m[1].toUpperCase()}${row}`, pass: false, x, y }
}

/**
 * 坐标数组转序列文本（如 ['pd','dp'] -> 'Q16 D4'）。
 * @param {string[]} coords SGF 坐标数组
 * @param {number} size 棋盘路数
 * @returns {string}
 */
export function coordList(coords, size = 19) {
  return (coords ?? []).map((c) => coordLabel(c, size).label).join(' ')
}

/**
 * 把 parseGame 的棋局压成「逐格数据」：主变化线与摆子都转成整数坐标。
 *
 * 为什么独占一个导出：这条转换原先只写在宿主面板路由里（index.mjs 的 compactBoard），
 * 而画棋盘/算领地（src/diagram.js 的 buildGrid、src/territory.js）在工具侧也要用。
 * 两边各写一份必然会漂——本项目已经因为「两套管线」吃过亏（见 tools.js 的
 * autoComputeIfNeeded 注释），所以只保留这一份实现。
 *
 * @param {object} game parseGame 的返回值
 * @returns {{ size: number, komi: number, handicap: number,
 *             moves: Array<{c: string, x: number, y: number}>,
 *             setup: { black: number[][], white: number[][] } }}
 *   虚着用 x=y=-1 表示（棋盘不落子，但手顺要保留，否则手数对不上）
 */
export function compactBoard(game) {
  const size = game?.info?.size ?? 19
  /** 坐标 -> [x, y]；虚着/越界返回 null。 */
  const point = (coord) => {
    const at = coordLabel(coord ?? '', size)
    if (at.pass || at.x < 0 || at.y < 0 || at.x >= size || at.y >= size) return null
    return [at.x, at.y]
  }
  return {
    size,
    komi: game?.info?.komi ?? 0,
    handicap: game?.info?.handicap ?? 0,
    moves: (game?.moves ?? []).map((m) => {
      const p = m.pass ? null : point(m.coord)
      return p === null ? { c: m.color, x: -1, y: -1 } : { c: m.color, x: p[0], y: p[1] }
    }),
    setup: {
      black: (game?.setup?.black ?? []).map(point).filter((p) => p !== null),
      white: (game?.setup?.white ?? []).map(point).filter((p) => p !== null),
    },
  }
}

/**
 * KataGo 风格坐标数组转序列文本。
 * @param {string[]} coords KataGo 坐标数组
 * @param {number} size 棋盘路数
 * @returns {string}
 */
export function kataCoordList(coords, size = 19) {
  return (coords ?? []).map((c) => kataCoordLabel(c, size).label).join(' ')
}

// ---------------------------------------------------------------------------
// 分析数据提取（三通道：KataGo 属性 WV/DM/PV；LZ/LZOP 分析属性；
// 第三方 GUI 写进 C[] 的分析文本。实测该 GUI 2.5.3：LZ 头部为
// "引擎 黑方胜率% 计算量 scoreMean 不确定度"，scoreMean 为白方视角领先；
// C[] 为 "黑棋 胜率: x% (±y%)\n领先: z (Δ)\n(引擎 / 计算量)"，黑方视角。）
// ---------------------------------------------------------------------------

/**
 * 解析第三方 GUI 写入的 LZ/LZOP 分析属性。
 * 实测约定（2.5.3，config winrateAlwaysBlack=false 默认）：
 *   头部 winrate = 落子者（根节点为行棋方）的胜率；
 *   头部 score = 对手视角领先（= 落子者领先取负）。
 * @param {string} value LZ 属性原文
 * @returns {{ engine?: string, winratePct?: number, playouts?: string, scoreLeadOpponent?: number,
 *   stdev?: number, candidates: Array<{ coord, visits, winratePer10000, prior, scoreMean, pv: string[] }> } | null}
 */
export function parseLz(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const out = { candidates: [] }
  const lines = value.split('\n')
  // playouts 允许 k/M 量级后缀（如 "3.9k" / "1.2M"）：第三方 GUI 的分析量超过 999 后
  // 会改写成这种紧凑写法，早期只接受纯数字会让该手整条头部解析失败（winrate 丢失）。
  const head = /^(\S+)\s+([\d.]+)\s+([\d.]+[kKmM]?)\s+(-?[\d.]+)\s+([\d.]+)/.exec(lines[0]?.trim() ?? '')
  if (head) {
    out.engine = head[1]
    out.winratePct = parseFloat(head[2])
    out.playouts = head[3]
    out.scoreLeadOpponent = parseFloat(head[4])
    out.stdev = parseFloat(head[5])
  }
  for (let i = 1; i < lines.length; i++) {
    // 真实 LZ 值中候选点常在同一行，以 " info" 分隔（"info move ..."）
    const chunks = lines[i].split(/\s+info\s+(?=move\s)/).map((c) => c.replace(/\s+info\s*$/, ''))
    for (const chunk of chunks) {
      const m = /^\s*move\s+([A-Za-z]\d{1,2})\s+visits\s+(\d+)\s+winrate\s+(\d+)\s+prior\s+(\d+)\s+scoreMean\s+(-?[\d.]+)\s+pv\s+(.+?)\s*$/.exec(chunk.trim())
      if (!m) continue
      out.candidates.push({
        coord: m[1],
        visits: parseInt(m[2], 10),
        winratePer10000: parseInt(m[3], 10),
        prior: parseInt(m[4], 10),
        scoreMean: parseFloat(m[5]),
        pv: m[6].trim().split(/\s+/).filter(Boolean),
      })
    }
  }
  return out
}

/**
 * 把一手棋的分析序列化成 `LZ` 属性原文 —— {@link parseLz} 的逆运算。
 *
 * 为什么要有它：写回棋谱原先只落 `WV`/`DM`（逐手胜率/目差），**AI 首选与变化图
 * （候选着法 + PV）只活在内存里**。后果是文件重新打开时 `hasWinrateData()` 判为
 * 「已有分析」→ 不再补算，而 reviewGame 的候选只能来自节点上的 `lz.candidates`
 * → 首选点与变化图永久丢失（面板上的表现正是「有问题手，但没有首选/变化图」）。
 * 写回 `LZ` 后，任何一次读取（面板、工具、第三方 GUI）都不必重算就能拿到它们。
 *
 * 格式与第三方 GUI 逐字段对齐（实测 Lizzieyzy 2.5.3，见 test/fixtures/real-analysis.sgf）：
 *   头部行：`引擎 落子者胜率% 计算量 对手视角领先 不确定度`
 *   候选行：`move <GTP坐标> visits N winrate <万分比> prior N scoreMean X pv <GTP…>`，
 *           多个候选以 ` info ` 分隔（parseLz 依赖这两个分隔符与头部行）
 * 两点必须守住，否则读不回来：
 *   · 候选的 winrate / scoreMean 都是**该节点行棋方**（= 候选点自己一方）视角；
 *   · `prior` 必须在（parseLz 的正则要求它存在），缺失时补 0。
 *
 * @param {object} entry
 * @param {string} [entry.engine]
 * @param {number} entry.moverWinrate 落子者视角胜率（0~1）
 * @param {number|string} [entry.playouts] 计算量（整数或 3.9k 这类紧凑写法）
 * @param {number} [entry.opponentLead] 对手（= 该节点行棋方）视角领先目数
 * @param {number} [entry.stdev] 目差不确定度
 * @param {Array<{coord: string, visits?: number, winratePer10000?: number, prior?: number,
 *   scoreMean?: number, pv?: string[]}>} entry.candidates 候选着法（按优先度降序）
 * @returns {string|undefined} 无候选/无胜率时返回 undefined（此时不写 LZ）
 */
export function serializeLz(entry) {
  const raw = Array.isArray(entry?.candidates) ? entry.candidates : []
  const winratePct = toFixedSafe(entry?.moverWinrate !== undefined ? Number(entry.moverWinrate) * 100 : undefined, 1)
  if (raw.length === 0 || winratePct === undefined) return undefined

  const GTP = /^[A-Za-z]\d{1,2}$/
  const lines = []
  let firstVisits
  for (const c of raw) {
    const coord = typeof c?.coord === 'string' ? c.coord : undefined
    if (coord === undefined || !GTP.test(coord)) continue
    const pv = (Array.isArray(c?.pv) ? c.pv : []).filter((p) => typeof p === 'string' && GTP.test(p))
    if (firstVisits === undefined) firstVisits = toIntSafe(c?.visits)
    lines.push(
      `move ${coord}` +
      ` visits ${toIntSafe(c?.visits)}` +
      ` winrate ${toIntSafe(c?.winratePer10000)}` +
      ` prior ${toIntSafe(c?.prior)}` +
      ` scoreMean ${toFixedSafe(c?.scoreMean, 2, 0)}` +
      ` pv ${(pv.length > 0 ? pv : [coord]).join(' ')}`,
    )
  }
  if (lines.length === 0) return undefined

  // 引擎名会作为 LZ 头部的第一个词写回 SGF，而 '\\' 与 ']' 在属性值里有结构含义：
  // 畸形或恶意输入不能让它把写回的副本写坏（2026-09 复审）。空白折成 '_'，
  // parseLz 读回时仍是同一个词。
  const engineRaw = typeof entry?.engine === 'string' && entry.engine.trim() !== '' ? entry.engine.trim() : 'KataGo'
  const engine = engineRaw.replace(/[\\\]]/g, '').replace(/\s+/g, '_').slice(0, 32) || 'KataGo'
  const playouts = compactNumber(entry?.playouts) ?? String(firstVisits ?? 0)
  const head = [
    engine,
    winratePct,
    playouts,
    toFixedSafe(entry?.opponentLead, 1, 0),
    // 不确定度必须非负：parseLz 的头部正则不接受符号（`([\d.]+)`）
    toFixedSafe(Math.abs(Number(entry?.stdev ?? 0)), 1, 0),
  ].join(' ')
  // 头部行必须在最前：parseLz 从第 2 行起找候选，缺了它第一条候选会被整条跳过
  return `${head}\n${lines.join(' info ')}`
}

/**
 * 定点格式化，非法值回落 fallback；-0 归一成 0（`(-0).toFixed()` 的符号会污染
 * 读回时的数值，`-0` 又不是合法 lossless JSON）。
 * @returns {string|undefined} value 非法且未给 fallback 时返回 undefined
 */
function toFixedSafe(value, digits, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback === undefined ? undefined : fallback.toFixed(digits)
  const r = Object.is(n, -0) ? 0 : n
  const rounded = Number(r.toFixed(digits))
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(digits)
}

/** 非负整数（LZ 格式里 visits/winrate/prior 都是整数）。 */
function toIntSafe(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

/** 计算量的紧凑写法（"250" / "3.9k"）；不合法时返回 undefined。 */
function compactNumber(value) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '')
  return /^\d+(?:\.\d+)?[kKmM]?$/.test(text) ? text : undefined
}

// 第三方 GUI 的分析注释格式："Move <N> 黑胜率: <x>% (±y%) (引擎 / 计算量)"，
// 以及 KataGo 注释行式 "engine winrate playouts scoreMean ..."。
// 以下正则尽量宽松，按注释常见形态提取数值。

const COMMENT_WINRATE_PATTERNS = [
  /(?:黑|白)?(?:棋|方)?\s*胜率\s*[:：]?\s*\d+(?:\.\d+)?\s*%/i,
  /Winrate[:：\s]*\d+(?:\.\d+)?\s*%/i,
]

const COMMENT_MOVE_PATTERN = /Move\s+(\d{1,4})\b/i

const COMMENT_LEAD_PATTERN = /领先\s*[:：]?\s*(-?[\d.]+)(?:\s*\(\s*-?[\d.]+\s*\))?/
const COMMENT_STDEV_PATTERN = /不确定度\s*[:：]?\s*([\d.]+)/
const COMMENT_ENGINE_PATTERN = /\(([^()/]{1,40})\s*\/\s*([^()]{0,20})\)/

/**
 * 从注释文本中提取分析数字（第三方 GUI / KataGo 的注释产物）。
 * 实测约定：胜率标签（黑棋/白棋）= 落子者颜色，数值 = 落子者胜率；
 * "领先" = 落子者视角领先（正 = 落子者领先）。
 * @param {string} comment 注释全文
 * @returns {{ moveNumber?: number, winratePct?: number, winrateColor?: 'black'|'white'|'unknown',
 *   scoreLeadMover?: number, stdev?: number, engine?: string, playouts?: string } | null}
 */
export function parseWinrateComment(comment) {
  if (typeof comment !== 'string' || comment.trim() === '') return null
  const out = {}
  const m = COMMENT_MOVE_PATTERN.exec(comment)
  if (m) out.moveNumber = parseInt(m[1], 10)
  const line = comment.split('\n').find((l) => COMMENT_WINRATE_PATTERNS.some((re) => re.test(l)))
  if (!line) return out.moveNumber !== undefined ? out : null
  const black = /(?:黑棋|黑方|黑)\s*胜率\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(line)
  const white = /(?:白棋|白方|白)\s*胜率\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(line)
  const bare = /(?:胜率|Winrate|winrate)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(line)
  if (black) {
    out.winratePct = parseFloat(black[1])
    out.winrateColor = 'black'
  } else if (white) {
    out.winratePct = parseFloat(white[1])
    out.winrateColor = 'white'
  } else if (bare) {
    out.winratePct = parseFloat(bare[1])
    out.winrateColor = 'unknown'
  }
  const lead = COMMENT_LEAD_PATTERN.exec(comment)
  if (lead) out.scoreLeadMover = parseFloat(lead[1])
  const stdev = COMMENT_STDEV_PATTERN.exec(comment)
  if (stdev) out.stdev = parseFloat(stdev[1])
  const engine = COMMENT_ENGINE_PATTERN.exec(comment)
  if (engine) {
    out.engine = engine[1].trim()
    out.playouts = engine[2].match(/\d+(?:\.\d+)?[kKmM]?/)?.[0] ?? engine[2].trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// 主解析
// ---------------------------------------------------------------------------

const ROOT_NUMERIC_PROPS = ['SZ', 'KM', 'HA']

/**
 * 解析前的输入上限。
 *
 * 为什么必须在 `sgf.parse()` **之前**：@sabaki/sgf 会把整棵树一次性材质化，而原先
 * 唯一的防御（走主线时的 2000 手上限）是在解析**之后**才生效的 —— 一个深嵌套或
 * 超多变化的畸形 SGF，可以在那道上限生效前就把内存与 CPU 吃满（2026-09 复核）。
 */
export const MAX_SGF_CHARS = 8 * 1024 * 1024
/** 解析前的节点数上限（'(' 与 ';' 的总数；宽松，只用来挡住畸形/拼接输入）。 */
export const MAX_SGF_NODES = 200_000
/**
 * 解析前的嵌套深度上限。
 *
 * 为什么要单独限深度：@sabaki/sgf 是递归下降解析器，`((((…` 这类输入会在节点数
 * 上限之前先把调用栈爆掉（抛 RangeError 而不是可读的拒绝）。真实棋谱的嵌套极浅
 * （主线 + 几层变化图，实测 ≤ 10），512 层足够宽松又远离栈上限（2026-09 复审）。
 */
export const MAX_SGF_DEPTH = 512

/** 解析前的输入守卫：字符数、节点数与嵌套深度。超限直接抛错，不进入解析器。 */
function guardParseInput(text) {
  const content = typeof text === 'string' ? text : ''
  if (content === '') throw new Error('SGF 内容为空')
  if (content.length > MAX_SGF_CHARS) {
    throw new Error(`棋谱过大：${content.length} 字符，上限 ${MAX_SGF_CHARS} 字符；请在打谱软件里另存为单局棋谱`)
  }
  // 词法扫描：区分「属性值内部」与结构字符（`C[;]` 里的 ';' 不算节点），顺便量嵌套深度。
  let nodes = 0
  let depth = 0
  let inValue = false
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i)
    if (inValue) {
      if (code === 0x5c) { i += 1; continue } // '\' 转义：跳过被转义的那个字符
      if (code === 0x5d) inValue = false // ']' 结束属性值
      continue
    }
    if (code === 0x5b) { inValue = true; continue } // '[' 开始属性值
    if (code === 0x28 || code === 0x3b) { // '(' 或 ';'
      nodes += 1
      if (nodes > MAX_SGF_NODES) {
        throw new Error(`棋谱节点过多（超过 ${MAX_SGF_NODES} 个节点）：疑似畸形输入或拼接了多局棋谱`)
      }
      if (code === 0x28) {
        depth += 1
        if (depth > MAX_SGF_DEPTH) {
          throw new Error(`棋谱嵌套过深（超过 ${MAX_SGF_DEPTH} 层）：疑似畸形输入`)
        }
      }
      continue
    }
    if (code === 0x29 && depth > 0) depth -= 1 // ')'
  }
}

/** 棋盘路数的合法区间（SGF 规范上限 52×52）。 */
export const MIN_BOARD_SIZE = 2
export const MAX_BOARD_SIZE = 52

/**
 * 把 SZ 归一化到合法区间，非法值退回 19 路。
 *
 * 为什么要在**源头**钳：SZ 会被 compactBoard / emptyGrid 直接当作 `new Array(size*size)`
 * 的边长 —— 一个 `SZ[9999]` 就是约 1 亿格，足以把宿主拖死（2026-09 复核）。
 */
export function clampBoardSize(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return 19
  return Math.min(MAX_BOARD_SIZE, Math.max(MIN_BOARD_SIZE, n))
}

function nodeDataAsObject(data) {
  // @sabaki/sgf 的 node.data 为 Map；防御性地同时支持普通对象。
  if (data instanceof Map) {
    const obj = {}
    for (const [k, v] of data) obj[k] = v
    return obj
  }
  return data ?? {}
}

/**
 * 解析 SGF 文本，产出结构化棋局（主变化线 + 每手分析元数据）。
 * @param {string} text SGF 文本
 * @returns {object} 见下方结构
 *   { info: { size, komi, handicap, result, players: {black, white, blackRank, whiteRank},
 *             date, gameName, rule, app, event }, moves: [...],
 *     setup: { black: string[], white: string[] }, stats: { games, variations, encodingNote } }
 *   每手: { number, color: 'B'|'W', coord, pass, analysis: { winrateWhite?, scoreLeadBlack?, pv?,
 *             comment?, commentAnalysis?, moves } | null }
 */
export function parseGame(text) {
  guardParseInput(text)
  const trees = sgf.parse(text)
  if (!Array.isArray(trees) || trees.length === 0) {
    throw new Error('SGF 解析失败：没有找到棋局（(; 根节点）')
  }
  const root = trees[0]
  const rootData = nodeDataAsObject(root.data)

  const num = (v) => {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (v) => (v === undefined || v === null ? undefined : String(v).trim())
  const komiRaw = num(rootData.KM?.[0]) ?? 0
  // 旧式 SGF 常见 KM[375]（贴目×100）写法：>20 视为百分制归一化
  const komi = komiRaw > 20 ? komiRaw / 100 : komiRaw

  const info = {
    size: clampBoardSize(num(rootData.SZ?.[0]) ?? 19),
    komi,
    handicap: num(rootData.HA?.[0]) ?? 0,
    result: str(rootData.RE?.[0]),
    date: str(rootData.DT?.[0]),
    gameName: repairMojibakeField(str(rootData.GN?.[0])),
    rule: str(rootData.RU?.[0]),
    app: str(rootData.AP?.[0]),
    event: repairMojibakeField(str(rootData.EV?.[0])),
    players: {
      black: repairMojibakeField(str(rootData.PB?.[0])),
      white: repairMojibakeField(str(rootData.PW?.[0])),
      blackRank: repairMojibakeField(str(rootData.BR?.[0])),
      whiteRank: repairMojibakeField(str(rootData.WR?.[0])),
    },
  }

  // 统计主变化线之外的旁支数量（第三方 GUI 保存的变化图即旁支）。
  let variations = 0
  const moves = []
  let node = root
  let number = 0
  let seen = 0
  while (node && node.children && node.children.length > 0) {
    variations += Math.max(0, node.children.length - 1)
    const child = node.children[0]
    const data = nodeDataAsObject(child.data)
    const black = data.B?.[0]
    const white = data.W?.[0]
    if (black !== undefined || white !== undefined) {
      number += 1
      seen += 1
      if (seen > 2000) break // 防御：异常棋谱上限
      const color = black !== undefined ? 'B' : 'W'
      const coord = (black !== undefined ? black : white) ?? ''
      const isPass = coord === '' || (coord === 'tt' && info.size === 19)
      const analysis = extractAnalysis(data, coord, isPass, info.size)
      moves.push({
        number,
        color,
        coord: isPass ? null : coord,
        pass: isPass,
        analysis,
        // 形势判断的三档图（TP[]）：单独挂在 move 上，读路径（面板/配图）直接取它。
        // analysis 里也留了一份（extractAnalysis 写的），写回时按 move.territory 处理。
        ...(analysis?.territory !== undefined ? { territory: analysis.territory } : {}),
      })
    }
    node = child
  }

  // 盘上初始就有的子（让子局、死活题、复盘摆图）：AB/AW 是根节点属性，
  // 不是着手，所以不在 moves 里。面板棋盘缺了它们就会少子，故单独返回。
  const setup = {
    black: extractSetup(rootData.AB, info.size),
    white: extractSetup(rootData.AW, info.size),
  }

  return { info, moves, setup, stats: { games: trees.length, variations, moves: number } }
}

/**
 * 提取根节点的摆子坐标（AB/AW），过滤虚着与越界坐标。
 * @param {unknown} value SGF 属性值数组（如 ['dd','pp']）
 * @param {number} size 棋盘路数
 * @returns {string[]} 合法的 SGF 坐标数组
 */
function extractSetup(value, size) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const coord = String(raw ?? '')
    const at = coordLabel(coord, size)
    if (at.pass || at.x < 0 || at.y < 0 || at.x >= size || at.y >= size) continue
    out.push(coord)
  }
  return out
}

/**
 * 从单个节点属性提取分析数据（KataGo 属性 + LZ 分析属性 + C[] 注释三通道）。
 */
function extractAnalysis(data, coord, isPass, size) {
  const analysis = { moves: isPass ? 0 : 1 }
  const wv = data.WV?.[0]
  const dm = data.DM?.[0]
  const pv = data.PV?.[0]
  const lz = data.LZ?.[0]
  const comment = data.C?.join('\n')

  if (wv !== undefined) {
    const n = parseFloat(wv)
    if (Number.isFinite(n)) analysis.winrateWhite = Math.min(1, Math.max(0, n))
  }
  if (dm !== undefined) {
    const n = parseFloat(dm)
    if (Number.isFinite(n)) analysis.scoreLeadBlack = n
  }
  if (pv !== undefined) {
    const tokens = String(pv).trim().split(/[\s,]+/).filter(Boolean)
    if (tokens.length > 0) analysis.pv = tokens
  }
  if (lz !== undefined) {
    const parsed = parseLz(lz)
    if (parsed && (parsed.engine || parsed.candidates.length > 0)) analysis.lz = parsed
  }
  // 归属图（形势判断的三档图，紧凑字符串）。与 WV/DM/LZ 同一次补算产出，单独一个属性。
  const tp = data.TP?.[0]
  if (typeof tp === 'string' && tp !== '') analysis.territory = tp
  if (comment !== undefined && comment.trim() !== '') {
    analysis.comment = comment
    const parsed = parseWinrateComment(comment)
    if (parsed) analysis.commentAnalysis = parsed
  }
  return Object.keys(analysis).length > 1 ? analysis : null
}

/**
 * 返回某手在其落子者视角的胜率（0~1）。无数据返回 undefined。
 * 三通道：WV 属性（KataGo 标准，白方视角）> C[] 注释（标签即落子者颜色）
 * > LZ 属性（实测为落子者视角）。
 * @param {object} move parseGame 产生的某一手
 */
export function winrateForMover(move) {
  const a = move?.analysis
  if (!a) return undefined
  if (a.winrateWhite !== undefined) {
    return move.color === 'W' ? a.winrateWhite : 1 - a.winrateWhite
  }
  const c = a.commentAnalysis
  if (c && c.winratePct !== undefined && c.winrateColor !== 'unknown') {
    const w = c.winratePct / 100
    // 标签 = 落子者颜色（'black'/'white'）；防御性地处理标签误判
    const isMover = c.winrateColor === (move.color === 'B' ? 'black' : 'white')
    return isMover ? w : 1 - w
  }
  if (a.lz && a.lz.winratePct !== undefined) {
    return a.lz.winratePct / 100 // LZ 胜率即落子者视角
  }
  return undefined
}

/**
 * 返回某手局面上指定颜色的胜率（0~1）。
 * @param {object} move parseGame 产生的某一手
 * @param {'B'|'W'} color 要查询的颜色
 */
export function winrateForColor(move, color) {
  const w = winrateForMover(move)
  if (w === undefined) return undefined
  return move.color === color ? w : 1 - w
}

/**
 * 棋谱是否带**可用于复盘的**逐手胜率数据。
 *
 * 判据不是"有一手能取到胜率"，而是"**至少有一处相邻两手都能取到**"：
 *   · 复盘算的是相邻手之间的落差（reviewGame 的 wBefore/wAfter 取自相邻两个节点），
 *     孤立一手带分析时一个候选都产生不了；
 *   · "有一手能取到"太松：实测有棋谱 96 手里只有 1 手能从人工注释解析出胜率，
 *     那种棋谱会被判成"已有分析"从而跳过补算，复盘又算不出问题手 —— 又是两头落空。
 *
 * @param {object} game parseGame 的返回值
 * @returns {boolean} 至少有一对相邻着手都能取到落子者视角胜率
 */
export function hasWinrateData(game) {
  return countWinratePairs(game) > 0
}

/**
 * 棋谱里有没有「形势判断」的归属图（`TP[]`）。
 *
 * 与 {@link hasWinrateData} 同属**能力判据**：要看有没有真数据（至少一手的 TP 非空），
 * 不能用 `analysis !== null` 这种结构判据 —— 只写了注释的棋谱也会产出 analysis 对象。
 *
 * 判据是**至少有归属图**而不是"每一手都有"：让"以前复盘过的副本"（有 WV/DM/LZ、
 * 没有 TP）能被识别为"缺归属、需要补算一次"。
 *
 * @param {object} game parseGame 的返回值
 * @returns {boolean}
 */
export function hasTerritoryData(game) {
  for (const move of game?.moves ?? []) {
    if (typeof move.territory === 'string' && move.territory !== '') return true
  }
  return false
}

/**
 * 逐手的形势判断（只读棋谱里已有的 `TP[]`，**不跑引擎**）。
 *
 * 一次重放给出每一手的三档图与数字：面板要的就是整条线，配图/工具只要其中一手
 * ——两者共用这一份实现，免得数字与图走两套算法。
 *
 * @param {object} game parseGame 的返回值
 * @returns {Array<{ packed: string, est: object, text: string }|null>} 与 moves 等长
 */
export function territorySeriesOf(game) {
  const size = game?.info?.size ?? 19
  const moves = game?.moves ?? []
  const replayer = createReplayer(compactBoard(game))
  const out = new Array(moves.length).fill(null)
  for (let i = 0; i < moves.length; i++) {
    replayer.step(replayer.moves[i])
    const packed = typeof moves[i]?.territory === 'string' ? moves[i].territory : ''
    if (packed === '') continue
    const cells = unpackTerritory(packed, size * size)
    if (cells === null) continue
    const { capturedBlack, capturedWhite } = replayer.captures()
    const est = scoreFromCells(replayer.board, size, cells, {
      komi: game?.info?.komi ?? 0,
      capturedBlack,
      capturedWhite,
    })
    if (est === null) continue
    out[i] = { packed, est, text: territoryScoreText(est) }
  }
  return out
}

/**
 * 取某一手之后的形势判断。没有该手的归属数据时返回 null。
 * @param {object} game parseGame 的返回值
 * @param {number} moveNumber 手数（1 起；取该手之后的局面）
 * @returns {{ packed: string, est: object, text: string }|null}
 */
export function territoryOfMove(game, moveNumber) {
  const index = Math.trunc(Number(moveNumber))
  if (!Number.isFinite(index) || index < 1) return null
  return territorySeriesOf(game)[index - 1] ?? null
}

/**
 * 能算出落差的着手数（相邻两手都能取到胜率）。
 * 诊断用：为 0 就说明这盘棋只有靠补算才讲得动。
 * @param {object} game parseGame 的返回值
 * @returns {number}
 */
export function countWinratePairs(game) {
  const moves = game?.moves ?? []
  let pairs = 0
  for (let i = 1; i < moves.length; i++) {
    if (winrateForMover(moves[i]) !== undefined && winrateForMover(moves[i - 1]) !== undefined) pairs += 1
  }
  return pairs
}

/**
 * 返回某手在其落子者视角的目数领先（正=领先）。无数据返回 undefined。
 * DM 为黑方视角；C[]"领先"为落子者视角；LZ score 为对手视角（取负即落子者视角）。
 * @param {object} move parseGame 产生的某一手
 */
export function scoreForMover(move) {
  const a = move?.analysis
  if (!a) return undefined
  if (a.scoreLeadBlack !== undefined) {
    return move.color === 'B' ? a.scoreLeadBlack : -a.scoreLeadBlack
  }
  const c = a.commentAnalysis
  if (c && c.scoreLeadMover !== undefined) {
    return c.scoreLeadMover
  }
  if (a.lz && a.lz.scoreLeadOpponent !== undefined) {
    return -a.lz.scoreLeadOpponent
  }
  return undefined
}

/**
 * 返回某手局面上指定颜色的目数领先（正=领先）。
 * @param {object} move parseGame 产生的某一手
 * @param {'B'|'W'} color 要查询的颜色
 */
export function scoreForColor(move, color) {
  const s = scoreForMover(move)
  if (s === undefined) return undefined
  return move.color === color ? s : -s
}

// ---------------------------------------------------------------------------
// C[] 注释回写（token 级扫描，保留原文件格式与旁支）
// ---------------------------------------------------------------------------

function escapeComment(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

/**
 * 向主变化线指定手注入/合并 C[] 注释。
 *
 * 用 @sabaki/sgf 解析出变化树，沿**真正的第一个子节点**走主线（与
 * parseGame/reviewGame 完全同一套遍历规则），在该节点的 C[] 上追加/覆盖注释，
 * 再整树重新序列化。
 *
 * 为什么不自己扫描括号：SGF 的旁支括号与"主线继续"在文本上无法用朴素深度计数
 * 区分。带分析的棋谱常把实战进行写成**第一个子节点**，而形如
 * `](;B[de]…)(;B[fd]…)` 的写法看起来像"旁支紧随其后"，早期实现据此无条件跳过
 * 每个 `(`，结果跳过了真正的主线：106 手的棋谱只认到第 14 手，其余手全部
 * 被判为"不存在"而无法写回（实测 real-analysis.sgf）。
 * 交给解析器处理树结构即不存在这一歧义。
 *
 * 代价：输出为重新序列化的 SGF（属性集合与顺序保持，手数/旁支不丢），
 * 不再逐字节保留原文件排版。写入前请用 go_parse_sgf 复核。
 *
 * @param {string} sgfText 原始 SGF 文本
 * @param {Array<{ moveNumber: number, comment: string }>} entries 待写入注释（moveNumber 1-based）
 * @param {{ replace?: boolean, mergeSeparator?: string }} [opts] replace=true 覆盖已有注释
 * @returns {{ text: string, written: Array<number>, skipped: Array<number>, missing: Array<number> }}
 */
export function injectComments(sgfText, entries, opts = {}) {
  const { replace = false, mergeSeparator = '\n' } = opts
  const out = { written: [], skipped: [], missing: [] }

  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: sgfText, ...out }
  }
  const sorted = [...entries]
    .map((e) => ({ moveNumber: Math.trunc(Number(e.moveNumber)), comment: String(e.comment ?? '') }))
    .filter((e) => Number.isFinite(e.moveNumber) && e.moveNumber >= 1 && e.comment !== '')
    .sort((a, b) => a.moveNumber - b.moveNumber)

  guardParseInput(sgfText)
  const trees = sgf.parse(sgfText)
  if (trees.length === 0) return { text: sgfText, ...out }

  // 沿第一个子节点枚举主线手数（与 parseGame 的 main-line 规则一致）。
  const moveNodes = new Map() // moveNumber -> node
  for (const tree of trees) {
    let node = tree
    let number = 0
    while (node !== undefined && node !== null) {
      if (node.data && (node.data.B !== undefined || node.data.W !== undefined)) {
        number += 1
        if (!moveNodes.has(number)) moveNodes.set(number, node)
      }
      const next = node.children?.[0]
      if (next === undefined) break
      node = next
    }
    break // 与 parseGame 相同：只取第一局
  }

  const merged = new Map() // moveNumber -> 已合并条数
  for (const entry of sorted) {
    const node = moveNodes.get(entry.moveNumber)
    if (node === undefined) {
      out.missing.push(entry.moveNumber)
      continue
    }
    const k = merged.get(entry.moveNumber) ?? 0
    const piece = k === 0 ? entry.comment : mergeSeparator + entry.comment
    merged.set(entry.moveNumber, k + 1)

    const existing = node.data.C
    if (replace || existing === undefined) {
      node.data.C = [replace ? entry.comment : piece]
    } else {
      // 并入已有 C[]：换行追加（同名属性多值时逐条输出）
      node.data.C = [...existing, piece]
    }
    out.written.push(entry.moveNumber)
  }

  if (out.written.length === 0) return { text: sgfText, ...out }
  out.written.sort((a, b) => a - b)
  return { text: sgf.stringify(trees, { linebreak: '\n' }), ...out }
}

/**
 * 把逐手分析写回 SGF 的 KataGo 属性（`WV`/`DM` 与 `LZ`）。
 *
 * 为什么要写回：补算结果原先只活在内存里 —— 每次重新打开同一份棋谱都要再跑一次
 * 引擎（真机实测 30~100 秒），而"讲解已写回注释、却没有胜率数据"的棋谱在别的
 * 打谱软件里也一样是空白的。写回后文件自带 `WV`/`DM`，任何一方再读都不必重算。
 *
 * `LZ` 是第二件必须写回的东西：光有 `WV`/`DM` 只够算「问题手」，**AI 首选与变化图
 * 存在候选着法里**，而候选又只认节点上的 `LZ`/`lz` 属性（见 reviewGame 的取候选处）。
 * 缺了它，文件再次打开时既不会补算（已有胜率数据）、又拿不出首选/变化图。
 *
 * 口径与读取端严格对齐（`src/sgf.js` 的 parseGame / winrateForColor）：
 *   · `WV` = **白方**视角胜率（0~1 小数）；
 *   · `DM` = **黑方**视角领先目数；
 *   · `LZ` = 头部落子者视角、候选该节点行棋方视角（见 serializeLz）。
 * 传入的是落子者视角的原始量，这里负责换算 —— 两个方向各写错一次就会得到
 * "胜率恒等于对手"的静默错误，故换算只在此处发生一次。
 *
 * 与 injectComments 同法：交给 @sabaki/sgf 解析出变化树，沿真正的第一个子节点
 * 走主线，替换/新增该节点的 WV、DM、LZ，再整树重新序列化（幂等：重复调用不会堆积）。
 *
 * @param {string} sgfText 原始 SGF 文本
 * @param {Array<{ moveNumber: number, moverWinrate?: number, moverScoreLead?: number,
 *   engine?: string, playouts?: number|string, stdev?: number, candidates?: object[] }>} entries
 *   `moverWinrate` = 落子者视角胜率（0~1）；`moverScoreLead` = 落子者视角领先目数；
 *   `candidates` = 该节点的候选着法（有则写 `LZ`，即 AI 首选 + 变化图）
 * @returns {{ text: string, written: Array<number>, missing: Array<number> }}
 */
export function injectAnalysis(sgfText, entries) {
  const out = { written: [], missing: [] }
  if (!Array.isArray(entries) || entries.length === 0) return { text: sgfText, ...out }

  guardParseInput(sgfText)
  const trees = sgf.parse(sgfText)
  if (trees.length === 0) return { text: sgfText, ...out }

  // 与 parseGame / injectComments 同一条主线遍历规则：只取第一局、只走第一个子节点
  const moveNodes = new Map() // moveNumber -> { node, color }
  for (const tree of trees) {
    let node = tree
    let number = 0
    while (node !== undefined && node !== null) {
      const black = node.data?.B
      const white = node.data?.W
      if (black !== undefined || white !== undefined) {
        number += 1
        if (!moveNodes.has(number)) moveNodes.set(number, { node, color: black !== undefined ? 'B' : 'W' })
      }
      const next = node.children?.[0]
      if (next === undefined) break
      node = next
    }
    break
  }

  for (const entry of entries) {
    const moveNumber = Math.trunc(Number(entry?.moveNumber))
    if (!Number.isFinite(moveNumber) || moveNumber < 1) continue
    const found = moveNodes.get(moveNumber)
    if (found === undefined) {
      out.missing.push(moveNumber)
      continue
    }
    const isBlack = found.color === 'B'
    const winrate = Number(entry.moverWinrate)
    if (Number.isFinite(winrate) && winrate >= 0 && winrate <= 1) {
      // 落子者视角 → 白方视角：黑棋落子时取反
      const white = isBlack ? 1 - winrate : winrate
      found.node.data.WV = [String(Math.min(1, Math.max(0, Math.round(white * 10000) / 10000)))]
    }
    const lead = Number(entry.moverScoreLead)
    if (Number.isFinite(lead)) {
      // 落子者视角 → 黑方视角：白棋落子时取反；-0 归一（不是合法 JSON）
      const black = isBlack ? lead : -lead
      found.node.data.DM = [String(Object.is(black, -0) ? 0 : Math.round(black * 10) / 10)]
    }
    // AI 首选与变化图（候选着法 + PV）一并写回。只落 WV/DM 是**有损**的：文件下次被
    // 读到时有逐手胜率 → hasWinrateData() 为真 → 不再补算，而候选只能来自节点上的
    // lz.candidates → 首选点与变化图再也拿不回来（面板表现为「有问题手、没有首选/变化图」）。
    const lzValue = serializeLz({
      engine: entry.engine,
      moverWinrate: entry.moverWinrate,
      playouts: entry.playouts,
      // LZ 头部第 4 个字段是**对手**（= 该节点行棋方）视角领先，与候选点同视角
      opponentLead: Number.isFinite(Number(entry.moverScoreLead)) ? -Number(entry.moverScoreLead) : undefined,
      stdev: entry.stdev,
      candidates: entry.candidates,
    })
    if (lzValue !== undefined) found.node.data.LZ = [lzValue]
    // 归属图（形势判断的三档图）：与 WV/DM/LZ 同一次补算产出，单独存成 TP[]。
    // 客户端只画不算 —— 三档图就是最终渲染结果，两端不会漂。
    if (typeof entry.territory === 'string' && entry.territory !== '') {
      found.node.data.TP = [entry.territory]
    }
    out.written.push(moveNumber)
  }

  if (out.written.length === 0) return { text: sgfText, ...out }
  out.written.sort((a, b) => a - b)
  return { text: sgf.stringify(trees, { linebreak: '\n' }), ...out }
}

/**
 * 从已合成分析的棋局里取出可写回的逐手分析。
 *
 * 两种来源都要认：
 *   · 引擎补算通道 —— `analysis.lz.winratePct`（落子者视角百分点）与 `scoreLeadOpponent`；
 *   · 棋谱自带的 KataGo 属性 —— `analysis.winrateWhite` / `analysis.scoreLeadBlack`。
 * 统一换算成**落子者视角**交给 injectAnalysis，换算规则只在那里实现一次。
 *
 * 引擎通道还会带上候选着法（`lz.candidates`）与头部元数据 —— 那是 AI 首选与变化图
 * 的唯一来源，不带就等于写回一份"有问题手、没有首选/变化图"的棋谱。
 *
 * @param {object} game parseGame 的返回值（可能已被补算就地替换 moves）
 * @returns {Array<{ moveNumber: number, moverWinrate?: number, moverScoreLead?: number,
 *   engine?: string, playouts?: number|string, stdev?: number, candidates?: object[] }>}
 */
export function analysisEntriesOf(game) {
  const out = []
  for (const move of game?.moves ?? []) {
    const a = move.analysis
    if (!a) continue
    const isBlack = move.color === 'B'
    let moverWinrate
    let moverScoreLead
    if (a.lz?.winratePct !== undefined) moverWinrate = a.lz.winratePct / 100
    else if (a.winrateWhite !== undefined) moverWinrate = isBlack ? 1 - a.winrateWhite : a.winrateWhite
    if (a.lz?.scoreLeadOpponent !== undefined) {
      // scoreLeadOpponent 记的是**对手**视角领先 → 落子者视角取反
      moverScoreLead = -a.lz.scoreLeadOpponent
    } else if (a.scoreLeadBlack !== undefined) {
      moverScoreLead = isBlack ? a.scoreLeadBlack : -a.scoreLeadBlack
    }
    if (moverWinrate === undefined && moverScoreLead === undefined && move.territory === undefined) continue
    const candidates = Array.isArray(a.lz?.candidates) ? a.lz.candidates : []
    out.push({
      moveNumber: move.number,
      ...(moverWinrate !== undefined ? { moverWinrate } : {}),
      ...(moverScoreLead !== undefined ? { moverScoreLead } : {}),
      ...(typeof move.territory === 'string' && move.territory !== '' ? { territory: move.territory } : {}),
      ...(candidates.length > 0
        ? {
            candidates,
            ...(typeof a.lz.engine === 'string' ? { engine: a.lz.engine } : {}),
            ...(a.lz.playouts !== undefined ? { playouts: a.lz.playouts } : {}),
            ...(a.lz.stdev !== undefined ? { stdev: a.lz.stdev } : {}),
          }
        : {}),
    })
  }
  return out
}

/**
 * 字符级扫描版（保留作对照/回退，不再用于写入路径）。
 *
 * ⚠️ 已知缺陷：形如 `](;B[de]…)(;B[fd]…)` 的文件中，实战主线就是第一个子节点，
 * 但本实现把每个 `(` 都当作旁支跳过，导致主线在分叉点后被腰斩，后续手数全部
 * 判为不存在。保留仅为历史参照，请勿在新代码中调用。
 * @deprecated 使用 {@link injectComments}
 */
export function injectCommentsByScanner(sgfText, entries, opts = {}) {
  const { replace = false, mergeSeparator = '\n' } = opts
  const out = { written: [], skipped: [], missing: [] }

  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: sgfText, ...out }
  }
  const sorted = [...entries]
    .map((e) => ({ moveNumber: Math.trunc(Number(e.moveNumber)), comment: String(e.comment ?? '') }))
    .filter((e) => Number.isFinite(e.moveNumber) && e.moveNumber >= 1 && e.comment !== '')
    .sort((a, b) => a.moveNumber - b.moveNumber)

  // 第一遍：扫描主变化线，记录每手节点信息。
  const moveMap = new Map() // moveNumber -> { movePropEnd, hasComment, commentPropStart, commentValueEnd }
  let i = 0
  let moveCount = 0
  let seenNode = false // 已进入过任何节点；最外层 '('（GameTree 开头）不算变化图
  const n = sgfText.length
  while (i < n) {
    const ch = sgfText[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '(' && seenNode) {
      // 旁支（变化图）：跳到配对的 ')'，内部跳过转义与嵌套
      let depth = 1
      i++
      while (i < n && depth > 0) {
        const c = sgfText[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '(') depth++
        else if (c === ')') depth--
        i++
      }
      continue
    }
    if (ch === ';') {
      seenNode = true
      i++
      const node = { movePropEnd: -1, hasComment: false, commentPropStart: -1, commentValueEnd: -1 }
      while (i < n) {
        const c = sgfText[i]
        if (!/[A-Z]/.test(c)) break // 节点结束（';'、'('、')' 或 EOF）
        const tagStart = i
        while (i < n && /[A-Z]/.test(sgfText[i])) i++
        const tag = sgfText.slice(tagStart, i)
        if (sgfText[i] !== '[') break
        i++ // 跳过 '['
        let valueEnd = -1
        while (i < n) {
          const v = sgfText[i]
          if (v === '\\') {
            i += 2
            continue
          }
          if (v === ']') {
            valueEnd = i
            i++
            break
          }
          i++
        }
        if (valueEnd < 0) break // 值未闭合：放弃该节点其余内容，安全退出
        if (tag === 'B' || tag === 'W') {
          moveCount++
          node.movePropEnd = valueEnd
        } else if (tag === 'C') {
          node.hasComment = true
          node.commentPropStart = tagStart
          node.commentValueEnd = valueEnd
        }
      }
      if (node.movePropEnd >= 0) moveMap.set(moveCount, node)
      continue
    }
    i++
  }

  // 第二遍：从后往前插入（大偏移先插入，小偏移不受影响）。
  let text = sgfText
  const merged = new Map() // moveNumber -> 已合并条数（同一手多条注释按序合并）
  for (const entry of [...sorted].reverse()) {
    const mv = moveMap.get(entry.moveNumber)
    if (!mv) {
      out.missing.push(entry.moveNumber)
      continue
    }
    const k = merged.get(entry.moveNumber) ?? 0
    const piece = k === 0 ? entry.comment : mergeSeparator + entry.comment
    merged.set(entry.moveNumber, k + 1)
    if (replace && mv.hasComment) {
      text =
        text.slice(0, mv.commentPropStart) +
        `C[${escapeComment(entry.comment)}]` +
        text.slice(mv.commentValueEnd + 1)
      out.written.push(entry.moveNumber)
    } else if (!replace && mv.hasComment) {
      // 并入节点已有 C[]：以分隔符开头追加（先写回的多条仍按序拼接）
      const insertAt = mv.commentValueEnd
      text = text.slice(0, insertAt) + escapeComment(mergeSeparator + entry.comment) + text.slice(insertAt)
      out.written.push(entry.moveNumber)
    } else {
      const insertAt = mv.movePropEnd + 1
      text = text.slice(0, insertAt) + `C[${escapeComment(piece)}]` + text.slice(insertAt)
      out.written.push(entry.moveNumber)
    }
  }

  // 从后往前插入保证偏移稳定；结果按手数升序返回
  out.written.reverse()
  out.missing.reverse()
  return { text, ...out }
}

export { sgf }
