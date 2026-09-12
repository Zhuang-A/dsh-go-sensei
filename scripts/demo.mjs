// scripts/demo.mjs — 无模型演示：对任意 SGF 跑 解析→复盘→写回→报告 全链路
// 用法：node scripts/demo.mjs <sgf路径> [起始手] [结束手]
import { readFileSync, writeFileSync } from 'node:fs'
import { decodeBuffer, parseGame, injectComments } from '../src/sgf.js'
import { reviewGame, inferLevel } from '../src/review.js'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/demo.mjs <sgf路径> [起始手] [结束手]')
  process.exit(1)
}

const buf = readFileSync(file)
const { text, encoding } = decodeBuffer(buf)
const game = parseGame(text)
const from = Number(process.argv[3]) || 1
const to = Number(process.argv[4]) || game.moves.length
const review = reviewGame(game, {
  winrateThreshold: 0.03,
  scoreThreshold: 3,
  pvDepth: 6,
  maxPvCandidates: 3,
  minMove: from,
  maxCandidates: 50,
})

console.log(`== DeepGo Sensei 演示 ==`)
console.log(`棋谱：${file}（编码 ${encoding}）`)
console.log(`黑 ${game.info.players.black ?? '?'}（${game.info.players.blackRank ?? '?'}） vs 白 ${game.info.players.white ?? '?'}（${game.info.players.whiteRank ?? '?'}）`)
console.log(`${game.info.size} 路 / 贴目 ${game.info.komi} / 让子 ${game.info.handicap} / ${game.info.result ?? '未记录'} / 共 ${game.moves.length} 手`)
console.log(`模式：${review.mode === 'analysis' ? 'AI 分析' : '纯棋理（无分析数据）'}；建议讲解难度：${inferLevel(game.info)}`)
console.log()
if (review.candidates.length === 0) {
  console.log('区间内未发现明显问题手。')
} else {
  console.log('问题手候选：')
  for (const c of review.candidates) {
    console.log(
      `  第 ${String(c.moveNumber).padStart(3)} 手 ${c.color === 'B' ? '黑' : '白'} ${String(c.coordLabel ?? '').padStart(4)}  ${c.label.label}  胜率损失 ${String(c.winrateLoss ?? '-').padStart(5)}%  目差 ${String(c.scoreLoss ?? '-').padStart(5)}  AI候选: ${c.pv?.map((p) => p.label).join('/') ?? '-'}`,
    )
  }
}

// 演示写回：给前 3 个候选写示例注释到临时副本，不碰原文件
if (review.candidates.length > 0 && !file.endsWith('.demo.sgf')) {
  const demoFile = file.replace(/\.sgf$/i, '.demo.sgf')
  const entries = review.candidates.slice(0, 3).map((c) => ({
    moveNumber: c.moveNumber,
    comment: `[DeepGo Sensei 演示] ${c.label.label}：${c.coordLabel}，胜率损失 ${c.winrateLoss}%；AI 推荐 ${c.pv?.[0]?.label ?? '—'}。`,
  }))
  const result = injectComments(text, entries)
  writeFileSync(demoFile, result.text, 'utf8')
  console.log()
  console.log(`写回演示（不修改原文件）：${demoFile}（成功 ${result.written.length} 条）`)
}
