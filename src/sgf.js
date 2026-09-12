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
    size: num(rootData.SZ?.[0]) ?? 19,
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
