// src/territory.js — 简易形势判断（领地估算）
//
// 用户 2026-09-19 的要求是「参考 Lizzieyzy，在界面上加形势判断与领地显示」。
// Lizzieyzy 那条路有两种数据源：有引擎分析时用它给出的 ownership 归属图；
// 拿不到引擎数据时退回一套确定性的空点归属算法。本插件走**第二种**——
// 面板要能对任意一手即时出图（滑块拖到哪就画到哪），不可能每一手都去问引擎；
// 而且绝大多数棋谱（野狐导出、别人给的谱）根本没有 ownership 数据。
//
// 算法（纯函数：不读盘、不依赖 ctx，便于直接单测）：
//   1. 把空点按四连通切成若干「空块」；
//   2. 只看每个空块**紧邻**的棋子颜色：
//        只挨黑子 → 黑地；只挨白子 → 白地；
//        黑白都挨、或谁都不挨 → 单官（中立，不画也不计）；
//   3. 按**数子法**（中国规则）合计：
//        黑 = 黑子 + 黑地；白 = 白子 + 白地 + 贴目；正数 = 黑领先。
//
// ⚠ 这是**启发式估算**：不提死子、不判双活、不认眼形。讲解时只能说
// 「按这套简易点目，大约黑领先 X 目」，绝不能把它当引擎目差（DM/scoreLead）用。
// 面板图例与讲解口径都写成「简易形势判断」，就是为了不让人误当成引擎结论。
//
// 浏览器 half（client.js）里有一份**逐字对应**的实现：那边是零构建 bundle，
// 不能 import 本模块（与 groupAt/playStone 同一处境的既有约定）。两份必须同口径，
// 各自的单测都把关键局面钉死。

/** 逐格数组的边长上限（与 diagram.js 的 MAX_GRID_SIZE 同口径）。 */
const MAX_GRID_SIZE = 52

/** 防御性路数归一化：非数字/非正数退回 19 路，越界钳到 2..52。 */
function safeSize(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 19
  return Math.min(MAX_GRID_SIZE, Math.max(2, n))
}

/** 四舍五入到 1 位小数；-0 归零（-0 不是合法 lossless JSON）。 */
function round1(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const r = Math.round(n * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

/**
 * 从某个空点出发，四连通地吃掉一整块空点。
 *
 * 同时统计这块空点**紧邻**了哪些颜色的棋子——归属只看这一个事实：
 * 只挨黑子＝黑地、只挨白子＝白地、都挨或都不挨＝单官。
 *
 * @param {number[]} cells 盘面网格（0 空 / 1 黑 / 2 白）
 * @param {number} n 棋盘路数
 * @param {number} start 起点下标
 * @param {Uint8Array} visited 已访问标记（原地修改）
 * @param {number[]} region 输出：本块空点的下标
 * @returns {0|1|2} 归属（0 单官/中立）
 */
function floodRegion(cells, n, start, visited, region) {
  const stack = [start]
  visited[start] = 1
  let touchBlack = false
  let touchWhite = false
  while (stack.length > 0) {
    const p = stack.pop()
    region.push(p)
    const x = p % n
    const y = (p - x) / n
    // 四邻逐个看：是子就记颜色，是空且没走过就继续扩
    if (x + 1 < n) step(p + 1)
    if (x > 0) step(p - 1)
    if (y + 1 < n) step(p + n)
    if (y > 0) step(p - n)
  }
  if (touchBlack && !touchWhite) return 1
  if (touchWhite && !touchBlack) return 2
  return 0

  /** 处理一个邻点：记颜色或入栈。 */
  function step(q) {
    const v = cells[q]
    if (v === 1) {
      touchBlack = true
      return
    }
    if (v === 2) {
      touchWhite = true
      return
    }
    if (visited[q] === 1) return
    visited[q] = 1
    stack.push(q)
  }
}

/**
 * 简易形势判断（领地估算）。
 *
 * @param {number[]} grid 盘面网格（0 空 / 1 黑 / 2 白，下标 = y*size+x）
 * @param {number} size 棋盘路数
 * @param {{ komi?: number }} [opts] komi＝贴目（数子法里算给白方）
 * @returns {{ owner: number[], size: number, blackStones: number, whiteStones: number,
 *   blackTerritory: number, whiteTerritory: number, dame: number,
 *   blackTotal: number, whiteTotal: number, lead: number, komi: number }}
 *   owner：每点归属（0 单官/中立，1 黑，2 白；盘上棋子记自己的颜色）；
 *   lead：正数＝黑领先（黑总计 − 白总计，白总计已含贴目）。
 */
export function estimateTerritory(grid, size, opts = {}) {
  const n = safeSize(size)
  const area = n * n
  // 逐格归一：不是数组、长度不足、或值不是 0/1/2 的，一律当空点（畸形输入不抛错）。
  // 顺便复制一份，保证估算绝不原地改调用方的盘面。
  const cells = new Array(area)
  const src = Array.isArray(grid) ? grid : []
  for (let i = 0; i < area; i++) {
    const v = src[i]
    cells[i] = v === 1 || v === 2 ? v : 0
  }
  const owner = new Array(area)
  const visited = new Uint8Array(area)
  let blackStones = 0
  let whiteStones = 0
  for (let i = 0; i < area; i++) {
    const v = cells[i]
    if (v === 1) {
      owner[i] = 1
      blackStones += 1
    } else if (v === 2) {
      owner[i] = 2
      whiteStones += 1
    } else {
      owner[i] = 0
    }
  }

  let blackTerritory = 0
  let whiteTerritory = 0
  let dame = 0
  const region = []
  for (let start = 0; start < area; start++) {
    if (cells[start] !== 0 || visited[start] === 1) continue
    region.length = 0
    const who = floodRegion(cells, n, start, visited, region)
    for (const p of region) owner[p] = who
    if (who === 1) blackTerritory += region.length
    else if (who === 2) whiteTerritory += region.length
    else dame += region.length
  }

  const rawKomi = Number(opts.komi)
  const komi = Number.isFinite(rawKomi) ? rawKomi : 0
  const blackTotal = blackStones + blackTerritory
  const whiteTotal = whiteStones + whiteTerritory + komi
  const lead = blackTotal - whiteTotal
  return {
    owner,
    size: n,
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    dame,
    blackTotal: round1(blackTotal),
    whiteTotal: round1(whiteTotal),
    lead: Object.is(lead, -0) ? 0 : round1(lead),
    komi: round1(komi),
  }
}

/**
 * 一句话形势判断（不含「简易形势判断」前缀）：三处视图与配图图注共用同一句。
 * @param {object} est estimateTerritory 的返回值
 * @returns {string} 如 `黑 45 目 · 白 38.5 目（含贴目 7.5）· 黑领先 6.5 目`
 */
export function territoryScoreText(est) {
  const lead = Number(est?.lead) || 0
  const tail = lead === 0
    ? '盘面两分'
    : `${lead > 0 ? '黑' : '白'}领先 ${round1(Math.abs(lead))} 目`
  return `黑 ${round1(est?.blackTotal)} 目 · 白 ${round1(est?.whiteTotal)} 目`
    + `（含贴目 ${round1(est?.komi)}）· ${tail}`
}

/**
 * 带前缀的完整形势判断文字（工具返回值 / 讲解里引用时用它）。
 * @param {object} est estimateTerritory 的返回值
 * @returns {string}
 */
export function formatTerritory(est) {
  return `简易形势判断（数子估目）：${territoryScoreText(est)}`
}
