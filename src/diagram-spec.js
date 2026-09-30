// src/diagram-spec.js — 「棋谱 + 变化图参数 → SVG」的唯一装配点
//
// 为什么要有这个模块：配图有**两个入口**，对同一份棋谱必须画出同一张图 ——
//   · 对话配图：go_draw_diagram 工具（src/tools.js）拿到棋谱后要能直接出图，
//     因为桌面端（DSH 0.2.0 的 dsh-app:// 页面）只能通过本机文件路径显示图片，
//     工具得先把 SVG 落在磁盘上；
//   · 面板/直链：/go-sensei/diagram 路由（index.mjs）按 URL 参数即时渲染。
// 两边各写一遍 grid / firstColor / lastMove 的推导，迟早会出现"同一个变化图
// 在对话里和在面板里颜色相反"的分歧（这类诊断成本极高）。所以装配只在这里做一次。
//
// 纯计算：只读入已解析的棋谱与参数 token，不读盘、不依赖 ctx，便于直接单测。

import { compactBoard } from './sgf.js'
import { buildGrid, parseSequence, parseMarks, renderBoardSvg } from './diagram.js'

/** 图注长度上限（与路由、工具两侧的既有口径一致）。 */
const CAPTION_MAX = 120

/**
 * 基准手数的唯一算法：省略＝末手，NaN／越界一律夹到 [0, 总手数]。
 *
 * 单独导出是因为调用方（go_draw_diagram）在装配 SVG 之前就要用这个手数去查
 * 归属图（形势判断），两边各写一遍就会在"省略 moveNumber 时到底画到第几手"
 * 上分叉。
 *
 * @param {object} game parseGame 的返回值
 * @param {number|string|undefined|null} raw 调用方给的手数
 * @returns {number} 夹住的 0-based 步数（＝第 N 手之后的盘面）
 */
export function diagramMoveOf(game, raw) {
  const total = compactBoard(game ?? {}).moves.length
  const parsed = raw === undefined || raw === null || raw === '' ? total : Math.trunc(Number(raw))
  return Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : total, total))
}

/**
 * 把「棋局 + 第几手 + 变化图 token + 标注 token」装配成 renderBoardSvg 的输入。
 *
 * token 一律是**未解析的原始写法**（如 `B:Q16` / `Q16` / `triangle:D4`），
 * 由本函数统一交给 parseSequence / parseMarks —— 命中与否、跳过了哪些项，
 * 都以这里返回的 sequence/marks 为准，调用方不要再自己解析一遍。
 *
 * @param {object} input
 * @param {object} input.game parseGame（或 readGameFile）的返回值
 * @param {number} [input.move] 基准手数（第 N 手之后的盘面）；省略＝末手，越界自动夹住
 * @param {string[]} [input.seqTokens] 变化图着法 token 列表
 * @param {string[]} [input.markTokens] 重点棋子标注 token 列表
 * @param {string} [input.caption] 图注（超长截断）
 * @param {number} [input.width] 像素宽度（renderBoardSvg 会夹到 120~1600）
 * @param {{cells: string, text: string}|null} [input.territory] 归属图（形势判断叠加）
 * @returns {{size: number, move: number, sequence: object, marks: object, svg: string}}
 */
export function buildDiagramSpec(input) {
  const game = input?.game ?? {}
  const size = game.info?.size ?? 19
  const board = compactBoard(game)
  const move = diagramMoveOf(game, input?.move)

  const grid = buildGrid(board, move)
  // 第 move 手之后的盘面轮到那一手的对手（move=0 时黑先）。这一行是"图上的编号
  // 颜色对不对"的唯一判据，路由与工具都只走这里。
  const firstColor = move === 0 ? 'B' : board.moves[move - 1]?.c === 'B' ? 'W' : 'B'
  const sequence = parseSequence(input?.seqTokens ?? [], size, firstColor)
  const marks = parseMarks(input?.markTokens ?? [], size)
  const lastMove = move > 0 && board.moves[move - 1].x >= 0 ? board.moves[move - 1] : null

  const territory = input?.territory ?? null
  // 转义由 renderBoardSvg 负责：图注、页脚、棋手名、标注文字在 src/diagram.js 里都过
  // 它内部的 esc()（`&`/`<`/`>`/引号），所以这里只截长度、不再自己转一次 —— 重复转义
  // 会把 `&` 变成 `&amp;amp;` 显示成乱码。这条信任边界写在这里，免得日后有人在两边各转一次。
  const svg = renderBoardSvg({
    size,
    grid,
    numbered: sequence.points,
    marks: marks.marks,
    lastMove,
    caption: String(input?.caption ?? '').slice(0, CAPTION_MAX),
    ...(territory !== null ? { territory: territory.cells, footer: territory.text } : {}),
    // 黑白棋手的名字直接画在盘上沿：配图在对话正文里，四周没有别的说明
    players: game.info?.players,
    width: input?.width,
  })

  return { size, move, sequence, marks, svg }
}
