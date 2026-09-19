// src/territory.js — 形势判断：把引擎的归属图判成「黑地 / 白地 / 未定」三档
//
// 口径照 Lizzieyzy 的 KataEstimate.java（用户 2026-09-19 指定），规则三条：
//   ① 阈值：|归属| < 0.4 的点一律算未定（不画、不计）—— TERRITORY_THRESHOLD
//   ② 四邻过滤：一个空点就算倾向黑，只要四邻里有一个倾向黑以外的点，它也不算黑地
//      （防孤点、画面干净；越界方向不检查）
//   ③ 死子判定：落在对方区域里的己方棋子按死子算——画对方的方块，并记进对方的「地」
// 另外存一份对局中的提子数（重放得出），只作展示。
//
// 输入 ownership 必须是**黑方视角**（正 = 黑）。引擎输出的符号跟着
// reportAnalysisWinratesAs 走，归一化在 engine.js 的 toBlackOwnership()。
//
// 三档图（cells）就是最终渲染结果，宿主与客户端共用这一份 —— 客户端只画不算，
// 避免两套算法漂移（v0.2.8 那套启发式就是因为两端各写一份才需要专门对拍）。

/** 未定阈值：|归属| 低于它就算没定下来（Lizzieyzy 的 estimateThreshold 默认值） */
export const TERRITORY_THRESHOLD = 0.4

const EMPTY = 0
const BLACK = 1
const WHITE = 2

/**
 * 手顺重放器：沿 compactBoard(game) 的产物重放，维护盘面与双方提子数。
 * 三处调用方（补算写回、配图、面板）共用它 —— 提子判定只有这一份实现。
 *
 * @param {object} compact compactBoard 的产物 { size, moves:[{c,x,y,pass}], setup }
 * @returns {{ board: Uint8Array, size: number, moves: object[], step: (m: object) => void,
 *   captures: () => { capturedBlack: number, capturedWhite: number } }}
 */
export function createReplayer(compact) {
  const size = compact?.size ?? 19
  const n = size * size
  const moves = compact?.moves ?? []
  const board = new Uint8Array(n)
  for (const [x, y] of compact?.setup?.black ?? []) board[y * size + x] = BLACK
  for (const [x, y] of compact?.setup?.white ?? []) board[y * size + x] = WHITE
  let capturedBlack = 0 // 黑方被提掉的子
  let capturedWhite = 0 // 白方被提掉的子

  const neighbors = (x, y) => {
    const out = []
    if (x > 0) out.push([x - 1, y])
    if (x < size - 1) out.push([x + 1, y])
    if (y > 0) out.push([x, y - 1])
    if (y < size - 1) out.push([x, y + 1])
    return out
  }
  const groupAt = (x, y) => {
    const color = board[y * size + x]
    const seen = new Set()
    const stones = []
    const libs = new Set()
    const stack = [[x, y]]
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()
      const key = cy * size + cx
      if (seen.has(key)) continue
      seen.add(key)
      stones.push([cx, cy])
      for (const [nx, ny] of neighbors(cx, cy)) {
        const v = board[ny * size + nx]
        if (v === EMPTY) libs.add(ny * size + nx)
        else if (v === color && !seen.has(ny * size + nx)) stack.push([nx, ny])
      }
    }
    return { stones, libs }
  }

  const step = (m) => {
    if (!m || m.pass || m.x < 0 || m.y < 0 || m.x >= size || m.y >= size) return
    const color = m.c === 'B' ? BLACK : WHITE
    board[m.y * size + m.x] = color
    const opp = color === BLACK ? WHITE : BLACK
    for (const [nx, ny] of neighbors(m.x, m.y)) {
      if (board[ny * size + nx] !== opp) continue
      const g = groupAt(nx, ny)
      if (g.libs.size === 0) {
        for (const [sx, sy] of g.stones) board[sy * size + sx] = EMPTY
        if (opp === BLACK) capturedBlack += g.stones.length
        else capturedWhite += g.stones.length
      }
    }
    const own = groupAt(m.x, m.y)
    if (own.libs.size === 0) {
      for (const [sx, sy] of own.stones) board[sy * size + sx] = EMPTY
      if (color === BLACK) capturedWhite += own.stones.length
      else capturedBlack += own.stones.length
    }
  }

  return {
    board,
    size,
    moves,
    step,
    captures: () => ({ capturedBlack, capturedWhite }),
  }
}

/**
 * 重放到第 upto 手之后的局面。
 *
 * @param {object} compact compactBoard 的产物
 * @param {number} upto 手数（1 起）；0 = 开局
 * @returns {{ board: Uint8Array, size: number, capturedBlack: number, capturedWhite: number }}
 */
export function replayTo(compact, upto) {
  const r = createReplayer(compact)
  const limit = Math.max(0, Math.min(Math.trunc(upto), r.moves.length))
  for (let i = 0; i < limit; i++) r.step(r.moves[i])
  return { board: r.board, size: r.size, ...r.captures() }
}

/**
 * 归属图 → 三档图（阈值 + 四邻过滤 + 死子判定）。
 *
 * @param {ArrayLike<number>} board 逐格棋子：0 空 / 1 黑 / 2 白（长度 size*size，下标 = y*size+x）
 * @param {number} size 棋盘路数
 * @param {ArrayLike<number>} ownership 黑方视角的归属值（-1~1），长度必须 = size*size
 * @param {{ threshold?: number }} [opts]
 * @returns {{ cells: Uint8Array, threshold: number }|null} 输入不合法时返回 null
 */
export function cellsFromOwnership(board, size, ownership, opts = {}) {
  const n = size * size
  if (!board || typeof board.length !== 'number' || board.length !== n) return null
  if (!ownership || typeof ownership.length !== 'number' || ownership.length !== n) return null
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : TERRITORY_THRESHOLD

  // ① 阈值：低于阈值的点归零（= 未定），其余保留符号
  const value = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = Number(ownership[i])
    value[i] = Number.isFinite(v) && Math.abs(v) >= threshold ? v : 0
  }

  /** 该点的四邻（越界跳过，与 Lizzieyzy 的 getRealCount* 一致） */
  const neighbors = (i) => {
    const x = i % size
    const y = (i - x) / size
    const out = []
    if (x > 0) out.push(i - 1)
    if (x < size - 1) out.push(i + 1)
    if (y > 0) out.push(i - size)
    if (y < size - 1) out.push(i + size)
    return out
  }

  const cells = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const stone = board[i]
    const v = value[i]
    if (stone === EMPTY) {
      // ② 四邻过滤：只要有邻居倾向黑以外的点，这个点也不算黑地；白方对称
      if (v > 0 && neighbors(i).every((j) => value[j] >= 0)) cells[i] = BLACK
      else if (v < 0 && neighbors(i).every((j) => value[j] <= 0)) cells[i] = WHITE
      continue
    }
    // ③ 死子：落在对方区域里的棋子。v === 0 视为在自己人手里（同 Lizzieyzy 的 >=0 / <=0）
    if (stone === BLACK && v < 0) cells[i] = WHITE
    else if (stone === WHITE && v > 0) cells[i] = BLACK
  }
  return { cells, threshold }
}

/**
 * 三档图 + 盘面 → 形势判断的数字（数子法：目 = 活子 + 地）。
 *
 * @param {ArrayLike<number>} board 逐格棋子（同上）
 * @param {number} size 棋盘路数
 * @param {ArrayLike<number>} cells 三档图（0 无标记 / 1 黑方块 / 2 白方块）
 * @param {object} [opts]
 * @param {number} [opts.komi] 贴目（默认 0）
 * @param {number} [opts.capturedBlack] 对局中黑方被提掉的子数（展示用）
 * @param {number} [opts.capturedWhite] 对局中白方被提掉的子数（展示用）
 * @returns {object|null} 输入不合法时返回 null
 */
export function scoreFromCells(board, size, cells, opts = {}) {
  const n = size * size
  if (!board || typeof board.length !== 'number' || board.length !== n) return null
  if (!cells || typeof cells.length !== 'number' || cells.length !== n) return null
  const komi = Number.isFinite(opts.komi) ? opts.komi : 0

  let blackAlive = 0
  let whiteAlive = 0
  let blackTerritory = 0
  let whiteTerritory = 0
  let deadBlack = 0
  let deadWhite = 0
  for (let i = 0; i < n; i++) {
    const stone = board[i]
    const cell = cells[i]
    if (stone === EMPTY) {
      if (cell === BLACK) blackTerritory++
      else if (cell === WHITE) whiteTerritory++
      continue
    }
    if (stone === BLACK) {
      // 死黑子：它的点在图上被画成白方块 —— 那是白方的地
      if (cell === WHITE) {
        deadBlack++
        whiteTerritory++
      } else blackAlive++
    } else if (stone === WHITE) {
      if (cell === BLACK) {
        deadWhite++
        blackTerritory++
      } else whiteAlive++
    }
  }

  const blackPoints = blackAlive + blackTerritory
  const whitePoints = whiteAlive + whiteTerritory
  const leadRaw = blackPoints - whitePoints - komi
  return {
    size,
    cells,
    blackAlive,
    whiteAlive,
    blackTerritory,
    whiteTerritory,
    deadBlack,
    deadWhite,
    capturedBlack: Math.max(0, Math.trunc(opts.capturedBlack ?? 0)),
    capturedWhite: Math.max(0, Math.trunc(opts.capturedWhite ?? 0)),
    blackPoints,
    whitePoints,
    komi,
    // 归一 -0：它不是合法 lossless JSON，工具返回值会因此被整体拒收
    lead: Object.is(leadRaw, -0) ? 0 : leadRaw,
  }
}

/**
 * 形势判断主入口（有归属图时用）。
 *
 * @param {ArrayLike<number>} board 逐格棋子：0 空 / 1 黑 / 2 白
 * @param {number} size 棋盘路数
 * @param {object} [opts] 见 cellsFromOwnership / scoreFromCells
 * @returns {object|null} 归属数据缺失/长度不符时返回 null
 */
export function estimateTerritory(board, size, opts = {}) {
  const made = cellsFromOwnership(board, size, opts.ownership, opts)
  if (made === null) return null
  const est = scoreFromCells(board, size, made.cells, opts)
  if (est === null) return null
  est.threshold = made.threshold
  return est
}

/**
 * 形势判断的一行文字（配图图注 / 工具返回值用）。
 * @param {object} est estimateTerritory / scoreFromCells 的返回值
 * @returns {string}
 */
export function territoryScoreText(est) {
  if (!est) return ''
  const lead = est.lead
  const who = lead === 0 ? '双方持平' : lead > 0 ? `黑领先 ${lead} 目` : `白领先 ${-lead} 目`
  const komi = est.komi === 0 ? '不贴目' : `含贴目 ${est.komi}`
  return `形势判断：黑 ${est.blackPoints} 目 · 白 ${est.whitePoints} 目（${komi}）· ${who}`
}

/**
 * 三档图 → 紧凑字符串（2 bit/点，base64），写进棋谱副本的 TP[] 属性。
 * @param {ArrayLike<number>} cells 三档图
 * @returns {string}
 */
export function packTerritory(cells) {
  if (!cells || cells.length === 0) return ''
  const bytes = new Uint8Array(Math.ceil(cells.length / 4))
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i] & 3
    if (v === 0) continue
    bytes[i >> 2] |= v << ((i & 3) * 2)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
}

/**
 * packTerritory 的逆运算。
 * @param {string} text 紧凑字符串
 * @param {number} n 点数（size*size）
 * @returns {Uint8Array|null} 解析失败返回 null
 */
export function unpackTerritory(text, n) {
  if (typeof text !== 'string' || text === '' || !Number.isFinite(n) || n <= 0) return null
  let binary
  try {
    binary = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary')
  } catch {
    return null
  }
  if (binary.length < Math.ceil(n / 4)) return null
  const cells = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const byte = binary.charCodeAt(i >> 2)
    if (Number.isNaN(byte)) continue
    cells[i] = (byte >> ((i & 3) * 2)) & 3
  }
  return cells
}

/**
 * 沿手顺重放并逐手做形势判断（补算写回时用）。
 *
 * @param {object} compact compactBoard 的产物
 * @param {Array<ArrayLike<number>|null|undefined>} ownerships 下标 = 手序（0 起）的黑方视角归属
 * @returns {Array<object|null>} 与 moves 等长；该手没有归属数据时为 null，元素为 { est, packed }
 */
export function estimateTerritorySeries(compact, ownerships) {
  const r = createReplayer(compact)
  const out = new Array(r.moves.length).fill(null)
  for (let i = 0; i < r.moves.length; i++) {
    r.step(r.moves[i])
    const ownership = ownerships?.[i]
    if (!ownership) continue
    const { capturedBlack, capturedWhite } = r.captures()
    const est = estimateTerritory(r.board, r.size, {
      ownership,
      komi: compact?.komi ?? 0,
      capturedBlack,
      capturedWhite,
    })
    if (est === null) continue
    out[i] = { est, packed: packTerritory(est.cells) }
  }
  return out
}
