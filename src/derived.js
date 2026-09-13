// src/derived.js — 派生文件命名（源文件只读，复盘产物落在 -sensei 副本里）
//
// 规则只有一条：**复盘的产物一律写进源棋谱同目录的 `<源名>-sensei.sgf`**，
// 源文件（野狐/弈城导出、别人给的棋谱）永远保持原样。
// 读的一侧按同一条规则走：`X.sgf` 的复盘副本若存在，就直接读副本 ——
// 否则同一盘棋会在"对话里复盘"和"面板里打开"之间看到两份不同的数据。
//
// 为什么用后缀而不是新目录：用户的原话是「在源文件名增加 -sensei 生成在同一文件夹」，
// 好处是棋谱与它的复盘副本始终相邻，用任何打谱软件打开都能一眼认出哪个是原始谱。

import { basename, dirname, join } from 'node:path'

/** 复盘副本的文件名后缀（插在扩展名之前）。 */
export const SENSEI_SUFFIX = '-sensei'

/**
 * 由源棋谱路径推出「复盘副本」路径：同目录、文件名插 `-sensei`。
 *
 * 幂等：本身就是副本（`xxx-sensei.sgf`）时原样返回，不会叠成 `-sensei-sensei`；
 * 非 `.sgf` 扩展名同样处理（后缀插在最后一个扩展名之前）。
 *
 * @param {string} p 源棋谱路径（绝对路径或相对路径，Windows/Posix 分隔符皆可）
 * @returns {string} 副本路径；空输入原样返回
 */
export function senseiPathFor(p) {
  const text = String(p ?? '')
  if (text === '') return text
  const base = basename(text)
  const dot = base.toLowerCase().endsWith('.sgf') ? base.length - 4 : base.length
  const stem = base.slice(0, dot)
  if (stem === '' || stem.toLowerCase().endsWith(SENSEI_SUFFIX)) return text
  const out = stem + SENSEI_SUFFIX + base.slice(dot)
  const dir = dirname(text)
  return dir === '' || dir === '.' ? out : join(dir, out)
}
