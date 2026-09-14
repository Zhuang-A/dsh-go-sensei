// src/diagram.js — 讲解配图（变化图 / 重点棋子标注）的 SVG 渲染
//
// 为什么要有它：课堂上一个变化图说十句话。用户 2026-09-14 的要求是
// 「AI 的回答要配图来解释自己的说明」——变化图着法按 1-9、A-Z 逐手编号，
// 关键棋子用三角形等方式标出来。
//
// 为什么放宿主 half 用纯函数实现、而不是复用 client.js 的 renderBoard：
//   · client.js 是零构建的浏览器 bundle（window.__ModuleLoader__ 装载），
//     不能 import 本模块；
//   · 配图要出现在**对话正文**里，形态是一张 PNG/SVG 图片（`<img src>`），
//     不是 React 元素树。
// 两边画法保持同一套视觉约定（木纹底、Lizzieyzy 配色），所以看起来是同一个产品。
//
// 本模块只做纯计算与字符串拼装：不读盘、不依赖 ctx，便于直接单测。

/** 列标（跳过 I，与 sgf.js 的 coordLabel 一致）。 */
export const COLS = 'ABCDEFGHJKLMNOPQRST'

/** SVG 视口是 100x100 的无量纲坐标，实际像素尺寸由 width/height 属性给。 */
const VIEW = 100
/** 边距：给坐标标注留出的空间（视口单位）。 */
const PAD = 8
/** 一颗棋子的半径（视口单位，与 client.js 同比例）。 */
const RADIUS = ((VIEW - PAD * 2) / 18) * 0.46

/** 支持的重点棋子标注形状。 */
export const MARK_SHAPES = ['triangle', 'square', 'circle', 'cross', 'label']

/**
 * 变化图第 n 手（0-based）的编号字符：1-9 之后转 A-Z。
 *
 * 用户明确要求「1-9，A-Z」这套编号（围棋书上的变化图惯例）。
 * 超过 9+26 = 35 手的变化图在复盘里不现实，多出的仍按 Z 之后循环取字母。
 *
 * @param {number} index 0-based
 * @returns {string} 单个字符
 */
export function numberLabel(index) {
  const i = Math.max(0, Math.trunc(Number(index) || 0))
  if (i < 9) return String(i + 1)
  const letter = i - 9
  return String.fromCharCode(65 + (letter % 26))
}

/**
 * KataGo 风格标签（'R16'）-> {x, y}；解析不了或落在盘外返回 null。
 * @param {string} label 形如 'R16'（列字母 + 行号）
 * @param {number} size 棋盘路数
 * @returns {{x: number, y: number}|null}
 */
export function parsePointLabel(label, size) {
  const m = /^([A-Za-z])\s*(\d{1,2})$/.exec(String(label == null ? '' : label).trim())
  if (m === null) return null
  const x = COLS.indexOf(m[1].toUpperCase())
  const row = parseInt(m[2], 10)
  if (x < 0 || x >= size || !(row >= 1 && row <= size)) return null
  return { x, y: size - row }
}

/** 空盘：0 空、1 黑、2 白；下标 = y * size + x。 */
export function emptyGrid(size) {
  const grid = new Array(size * size)
  for (let i = 0; i < grid.length; i++) grid[i] = 0
  return grid
}

/**
 * 取 (x,y) 所在棋串的同色点与气数（气点去重）。空点返回 null。
 * 与 client.js 的同名逻辑保持一致：配图上「连没连上、几口气」必须画得对。
 */
export function groupAt(grid, size, x, y) {
  const color = grid[y * size + x]
  if (color === 0) return null
  const stones = []
  let libs = 0
  const seen = {}
  const stack = [[x, y]]
  seen[y * size + x] = true
  while (stack.length > 0) {
    const p = stack.pop()
    stones.push(p)
    const nb = [[p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]]
    for (const n of nb) {
      const nx = n[0]
      const ny = n[1]
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const key = ny * size + nx
      if (seen[key] === true) continue
      seen[key] = true
      const v = grid[key]
      if (v === 0) libs += 1
      else if (v === color) stack.push([nx, ny])
    }
  }
  return { stones, libs }
}

/** 落子并提掉无气的对方棋串；返回被提子数。 */
export function playStone(grid, size, x, y, color) {
  grid[y * size + x] = color
  const opp = color === 1 ? 2 : 1
  let captured = 0
  const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
  for (const n of nb) {
    const nx = n[0]
    const ny = n[1]
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    if (grid[ny * size + nx] !== opp) continue
    const g = groupAt(grid, size, nx, ny)
    if (g !== null && g.libs === 0) {
      for (const s of g.stones) {
        grid[s[1] * size + s[0]] = 0
        captured += 1
      }
    }
  }
  const own = groupAt(grid, size, x, y)
  if (own !== null && own.libs === 0) {
    for (const s of own.stones) grid[s[1] * size + s[0]] = 0
  }
  return captured
}

/**
 * 摆出「前 upto 手」的局面（含 AB/AW 摆子）。
 * @param {{size: number, moves: object[], setup?: object}} board compactBoard 的产物
 * @param {number} upto 显示到第几手（0 = 开局）
 * @returns {number[]} 盘面网格（0 空 / 1 黑 / 2 白，下标 = y * size + x）
 */
export function buildGrid(board, upto) {
  const size = board.size
  const moves = board.moves || []
  const limit = Math.max(0, Math.min(Math.trunc(upto) || 0, moves.length))
  const grid = emptyGrid(size)
  const setup = board.setup || {}
  for (const p of setup.black || []) grid[p[1] * size + p[0]] = 1
  for (const p of setup.white || []) grid[p[1] * size + p[0]] = 2
  for (let i = 0; i < limit; i++) {
    const m = moves[i]
    if (m.x < 0 || m.y < 0) continue
    playStone(grid, size, m.x, m.y, m.c === 'B' ? 1 : 2)
  }
  return grid
}

/** 星位（19/13/9 路常用坐标，其余路数不画）。 */
export function starPoints(size) {
  const base = size === 19 ? [3, 9, 15] : size === 13 ? [3, 6, 9] : size === 9 ? [2, 4, 6] : []
  const out = []
  for (const i of base) for (const j of base) out.push([i, j])
  return out
}

/**
 * 解析变化图着法序列。
 *
 * 每一项形如 `'Q16'`（按轮转取色）或 `'B:Q16'`（显式指定颜色）。
 * 起始颜色应由调用方给：第 N 手之后的盘面，轮到的是第 N 手的对手（N=0 则黑先）。
 * 显式指定颜色的那一手也会改变后续轮转，免得一处手写颜色把后面全部错开。
 *
 * @param {string[]} list 着法序列
 * @param {number} size 棋盘路数
 * @param {'B'|'W'} firstColor 第一手的颜色
 * @returns {{points: Array<object>, skipped: string[]}}
 */
export function parseSequence(list, size, firstColor) {
  const points = []
  const skipped = []
  let color = firstColor === 'W' ? 'W' : 'B'
  const items = Array.isArray(list) ? list : []
  for (const raw of items) {
    const text = String(raw == null ? '' : raw).trim()
    if (text === '') continue
    let explicit = null
    let point = text
    const m = /^([BbWw])\s*[:：]\s*(.+)$/.exec(text)
    if (m !== null) {
      explicit = m[1].toUpperCase()
      point = m[2].trim()
    }
    const at = parsePointLabel(point, size)
    if (at === null) {
      skipped.push(text)
      continue
    }
    const use = explicit ?? color
    points.push({ x: at.x, y: at.y, color: use, label: numberLabel(points.length) })
    color = use === 'B' ? 'W' : 'B'
  }
  return { points, skipped }
}

/**
 * 解析重点棋子标注。每一项形如 `'triangle:Q16'`、`'label:Q16:A'`。
 * @param {string[]} list 标注列表
 * @param {number} size 棋盘路数
 * @returns {{marks: Array<object>, skipped: string[]}}
 */
export function parseMarks(list, size) {
  const marks = []
  const skipped = []
  const items = Array.isArray(list) ? list : []
  for (const raw of items) {
    const text = String(raw == null ? '' : raw).trim()
    if (text === '') continue
    const parts = text.split(':')
    let shape = String(parts[0] ?? '').trim().toLowerCase()
    if (shape === 'x' || shape === 'fork') shape = 'cross'
    if (shape === 'text') shape = 'label'
    const point = String(parts[1] ?? '').trim()
    const label = parts.slice(2).join(':').trim()
    const at = parsePointLabel(point, size)
    if (at === null || !MARK_SHAPES.includes(shape)) {
      skipped.push(text)
      continue
    }
    marks.push({ x: at.x, y: at.y, shape, ...(label !== '' ? { text: label } : {}) })
  }
  return { marks, skipped }
}

/** XML 文本转义（棋手名/图注里可能有 & < > "）。 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 画一张配图（SVG 字符串）。
 *
 * 视口 100 宽、100(+图注) 高；输出同时带 width/height 像素属性，
 * 在对话里由 CSS 的 max-width 收窄，因此按比例缩放不变形。
 *
 * @param {object} spec
 * @param {number} spec.size 棋盘路数
 * @param {number[]} spec.grid 盘面网格
 * @param {Array<{x:number,y:number,color:string,label:string}>} [spec.numbered] 变化图（带编号）
 * @param {Array<{x:number,y:number,shape:string,text?:string}>} [spec.marks] 重点棋子标注
 * @param {{x:number,y:number,color:string}|null} [spec.lastMove] 最后一手（反色小圆点）
 * @param {string} [spec.caption] 图注（画在图下方）
 * @param {number} [spec.width] 输出像素宽度，默认 640
 * @returns {string} 完整 SVG 文档
 */
export function renderBoardSvg(spec) {
  const size = Math.max(2, Math.trunc(spec.size) || 19)
  const grid = Array.isArray(spec.grid) ? spec.grid : emptyGrid(size)
  const caption = typeof spec.caption === 'string' ? spec.caption.trim() : ''
  const width = Math.max(120, Math.trunc(spec.width) || 640)
  const captionH = caption === '' ? 0 : 7
  const viewH = VIEW + captionH
  const height = Math.round((width * viewH) / VIEW)
  const step = (VIEW - PAD * 2) / Math.max(1, size - 1)
  const pos = (i) => PAD + i * step
  const last = spec.lastMove ?? null

  const out = []
  out.push('<defs>')
  out.push('<linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="#e8c383"/><stop offset="100%" stop-color="#d6a75d"/></linearGradient>')
  out.push('<radialGradient id="bk" cx="35%" cy="30%" r="78%">'
    + '<stop offset="0%" stop-color="#5c6169"/><stop offset="55%" stop-color="#22242a"/>'
    + '<stop offset="100%" stop-color="#0b0c0f"/></radialGradient>')
  out.push('<radialGradient id="wh" cx="35%" cy="30%" r="78%">'
    + '<stop offset="0%" stop-color="#ffffff"/><stop offset="62%" stop-color="#edeff3"/>'
    + '<stop offset="100%" stop-color="#c3c9d2"/></radialGradient>')
  out.push('</defs>')

  // 背景铺满「棋盘 + 图注」整块：图注画在木纹之外，若背景是透明的，
  // 深色底（聊天区）上那行字就看不见了 —— 必须连图注条一起铺底。
  out.push(`<rect x="0" y="0" width="${VIEW}" height="${viewH}" rx="1.5" fill="url(#wood)"/>`)

  for (let i = 0; i < size; i++) {
    const edge = i === 0 || i === size - 1
    const w = edge ? 0.55 : 0.28
    out.push(`<line x1="${pos(0).toFixed(2)}" y1="${pos(i).toFixed(2)}" x2="${pos(size - 1).toFixed(2)}" y2="${pos(i).toFixed(2)}" stroke="#111111" stroke-width="${w}"/>`)
    out.push(`<line x1="${pos(i).toFixed(2)}" y1="${pos(0).toFixed(2)}" x2="${pos(i).toFixed(2)}" y2="${pos(size - 1).toFixed(2)}" stroke="#111111" stroke-width="${w}"/>`)
  }
  for (const p of starPoints(size)) {
    out.push(`<circle cx="${pos(p[0]).toFixed(2)}" cy="${pos(p[1]).toFixed(2)}" r="0.75" fill="#111111"/>`)
  }
  for (let i = 0; i < size; i++) {
    out.push(`<text x="${pos(i).toFixed(2)}" y="${(PAD / 2 + 1.4).toFixed(2)}" font-size="2.8" fill="#111111" text-anchor="middle" font-family="sans-serif">${esc(COLS.charAt(i))}</text>`)
    out.push(`<text x="${(PAD / 2).toFixed(2)}" y="${(pos(i) + 1.1).toFixed(2)}" font-size="2.8" fill="#111111" text-anchor="middle" font-family="sans-serif">${size - i}</text>`)
  }

  // 盘面棋子（白子带描边，与 Lizzieyzy drawStoneSimple 一致）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = grid[y * size + x]
      if (v === 0) continue
      const black = v === 1
      out.push(`<circle cx="${pos(x).toFixed(2)}" cy="${pos(y).toFixed(2)}" r="${RADIUS.toFixed(3)}"`
        + ` fill="url(#${black ? 'bk' : 'wh'})"`
        + (black ? '' : ` stroke="#111111" stroke-width="${Math.max(0.12, RADIUS / 16).toFixed(3)}"`)
        + '/>')
    }
  }

  // 最后一手：反色小实心圆点（与 client.js / Lizzieyzy 同一记法）
  if (last !== null && last !== undefined && last.x >= 0 && last.y >= 0) {
    out.push(`<circle cx="${pos(last.x).toFixed(2)}" cy="${pos(last.y).toFixed(2)}" r="${(step * 0.22).toFixed(3)}"`
      + ` fill="${last.color === 'B' ? '#f3f4f6' : '#141519'}"/>`)
  }

  // 变化图：一颗实心棋子 + 正中编号（1-9、A-Z）。盘面已有的子被盖住即视为"这一手改在这里"。
  for (const p of Array.isArray(spec.numbered) ? spec.numbered : []) {
    if (p.x < 0 || p.y < 0 || p.x >= size || p.y >= size) continue
    const black = p.color !== 'W'
    const cx = pos(p.x).toFixed(2)
    const cy = pos(p.y).toFixed(2)
    out.push(`<circle cx="${cx}" cy="${cy}" r="${(RADIUS * 1.02).toFixed(3)}" fill="url(#${black ? 'bk' : 'wh'})"`
      + (black ? ' stroke="#7dd3fc" stroke-width="0.35"' : ' stroke="#111111" stroke-width="0.2"')
      + '/>')
    out.push(`<text x="${cx}" y="${(pos(p.y) + RADIUS * 0.45).toFixed(2)}" font-size="${(RADIUS * 1.3).toFixed(2)}"`
      + ` fill="${black ? '#ffffff' : '#111111'}" text-anchor="middle" font-family="sans-serif">${esc(p.label)}</text>`)
  }

  // 重点棋子：三角形 / 方块 / 圆圈 / 叉 / 字母。颜色取与底下棋子相反的对比色。
  for (const m of Array.isArray(spec.marks) ? spec.marks : []) {
    if (m.x < 0 || m.y < 0 || m.x >= size || m.y >= size) continue
    const onBlack = grid[m.y * size + m.x] === 1
    const ink = onBlack ? '#ffffff' : '#111111'
    const cx = pos(m.x)
    const cy = pos(m.y)
    const r = RADIUS * 0.62
    if (m.shape === 'triangle') {
      out.push(`<polygon points="${cx.toFixed(2)},${(cy - r).toFixed(2)} ${(cx - r * 0.92).toFixed(2)},${(cy + r * 0.72).toFixed(2)} ${(cx + r * 0.92).toFixed(2)},${(cy + r * 0.72).toFixed(2)}" fill="${ink}"/>`)
    } else if (m.shape === 'square') {
      out.push(`<rect x="${(cx - r * 0.8).toFixed(2)}" y="${(cy - r * 0.8).toFixed(2)}" width="${(r * 1.6).toFixed(2)}" height="${(r * 1.6).toFixed(2)}" fill="${ink}"/>`)
    } else if (m.shape === 'circle') {
      out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${ink}" stroke-width="0.45"/>`)
    } else if (m.shape === 'cross') {
      out.push(`<line x1="${(cx - r).toFixed(2)}" y1="${(cy - r).toFixed(2)}" x2="${(cx + r).toFixed(2)}" y2="${(cy + r).toFixed(2)}" stroke="${ink}" stroke-width="0.45"/>`)
      out.push(`<line x1="${(cx + r).toFixed(2)}" y1="${(cy - r).toFixed(2)}" x2="${(cx - r).toFixed(2)}" y2="${(cy + r).toFixed(2)}" stroke="${ink}" stroke-width="0.45"/>`)
    } else if (m.shape === 'label') {
      out.push(`<text x="${cx.toFixed(2)}" y="${(cy + r * 0.95).toFixed(2)}" font-size="${(r * 1.7).toFixed(2)}" fill="${ink}" text-anchor="middle" font-family="sans-serif">${esc(m.text ?? '?')}</text>`)
    }
  }

  if (caption !== '') {
    out.push(`<text x="${VIEW / 2}" y="${VIEW + 4.6}" font-size="3.6" fill="#3b2f1c" text-anchor="middle" font-family="sans-serif">${esc(caption)}</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${viewH}"`
    + ` width="${width}" height="${height}" role="img" aria-label="${esc(caption === '' ? '围棋局面配图' : caption)}">`
    + out.join('')
    + '</svg>'
}
