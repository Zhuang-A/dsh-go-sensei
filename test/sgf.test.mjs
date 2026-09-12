// test/sgf.test.mjs — sgf.js 单测（编码自愈 / 解析 / 分析提取 / C[] 回写）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'
import {
  decodeBuffer,
  repairMojibakeField,
  parseGame,
  parseLz,
  parseWinrateComment,
  coordLabel,
  kataCoordLabel,
  coordList,
  winrateForMover,
  winrateForColor,
  scoreForMover,
  hasWinrateData,
  countWinratePairs,
  injectComments,
} from '../src/sgf.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const readFixture = (name) => readFileSync(fixture(name))

test('decodeBuffer: UTF-8 正常解码', () => {
  const { text, encoding } = decodeBuffer(Buffer.from('(;GM[1]PB[黑棋])', 'utf8'))
  assert.equal(encoding, 'utf-8')
  assert.ok(text.includes('黑棋'))
})

test('decodeBuffer: 原始 GBK 文件回退 GBK 解码', () => {
  const buf = iconv.encode('(;GM[1]PB[庄生梦]PW[李四])', 'gbk')
  const { text, encoding } = decodeBuffer(buf)
  assert.equal(encoding, 'gbk')
  assert.ok(text.includes('庄生梦'))
  assert.ok(text.includes('李四'))
})

test('repairMojibakeField: 干净的双重 mojibake 可回修', () => {
  // '胜率' 的 UTF-8 字节被按 GBK 解码 = '鑳滅巼'（第三方 GUI 注释实测形态）
  const mojibake = iconv.decode(iconv.encode('胜率', 'utf8'), 'gbk')
  assert.equal(mojibake, '鑳滅巼')
  assert.equal(repairMojibakeField(mojibake), '胜率')
})

test('repairMojibakeField: 无签名字符的正常文本原样保留', () => {
  assert.equal(repairMojibakeField('庄生梦'), '庄生梦')
  assert.equal(repairMojibakeField('V296646120'), 'V296646120')
})

test('repairMojibakeField: 回修不干净（含替换符）时保留原文', () => {
  // '庄生梦' 9 字节，按 GBK 配对会多出半个字节 -> 产生 U+FFFD -> 不可无损回修
  const broken = iconv.decode(iconv.encode('庄生梦', 'utf8'), 'gbk')
  assert.ok(broken.includes('\ufffd'))
  assert.equal(repairMojibakeField(broken), broken)
})

test('parseGame: 合成分析棋谱的棋局信息', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(game.info.size, 19)
  assert.equal(game.info.komi, 7.5)
  assert.equal(game.info.handicap, 0)
  assert.equal(game.info.players.black, '庄生梦1n4k')
  assert.equal(game.info.players.blackRank, '18级')
  assert.equal(game.info.result, 'B+R')
  assert.equal(game.moves.length, 8)
  assert.equal(game.stats.moves, 8)
})

test('parseGame: 每手坐标与颜色', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.deepEqual(game.moves.map((m) => `${m.color}:${m.coord}`), [
    'B:pd', 'W:dp', 'B:qp', 'W:dd', 'B:cq', 'W:nc', 'B:fq', 'W:dq',
  ])
})

test('parseGame: 根节点 AB/AW 摆子（让子局、死活题都要画出来）', () => {
  const game = parseGame('(;GM[1]FF[4]SZ[19]HA[3]AB[dd][pp][dp]AW[jj];W[pd];B[qf])')
  assert.deepEqual(game.setup, { black: ['dd', 'pp', 'dp'], white: ['jj'] })
  assert.equal(game.info.handicap, 3)
  assert.equal(game.moves.length, 2, '摆子不算着手')
})

test('parseGame: 无摆子时 setup 形状稳定（两个空数组）', () => {
  const game = parseGame('(;GM[1]SZ[19];B[pd];W[dp])')
  assert.deepEqual(game.setup, { black: [], white: [] })
})

test('hasWinrateData: 只认「能取到逐手胜率」的棋谱', () => {
  // 带 LZ 属性 → 有可用胜率
  const lz = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(hasWinrateData(lz), true)
  assert.ok(countWinratePairs(lz) > 0)
  // 只有人工注释（注释里提到"胜率 45%"），解析不出可用胜率 → 不算有分析数据。
  // 旧判据用 analysis !== null，这类棋谱被当成"已有分析"跳过补算，复盘又只能
  // 退化成纯棋理，两头落空。
  const commentOnly = parseGame('(;GM[1]SZ[19];B[pd]C[这手胜率 45%，有点贪];W[dp]C[正常])')
  assert.ok(commentOnly.moves[0].analysis !== null, '注释会产生 analysis 对象（旧判据因此误判）')
  assert.equal(hasWinrateData(commentOnly), false)
  // 关键回归：**孤立一手**有胜率也不算 —— 复盘算的是相邻两手的落差。
  // 实测用户的棋谱 96 手里只有 1 手能从注释解析出胜率，"任一手有胜率"的判据会
  // 判成"已有分析"跳过补算，复盘却 0 问题手。
  const isolated = parseGame('(;GM[1]SZ[19];B[pd]C[黑棋 胜率: 45%];W[dp];B[qp];W[dd])')
  assert.equal(winrateForMover(isolated.moves[0]) !== undefined, true, '第 1 手确实能取到胜率')
  assert.equal(countWinratePairs(isolated), 0, '但没有相邻的一对')
  assert.equal(hasWinrateData(isolated), false)
  // 相邻两手都有 → 才算
  const adjacent = parseGame('(;GM[1]SZ[19];B[pd]C[黑棋 胜率: 45%];W[dp]C[白棋 胜率: 52%];B[qp])')
  assert.equal(countWinratePairs(adjacent), 1)
  assert.equal(hasWinrateData(adjacent), true)
  // 光秃秃的棋谱
  assert.equal(hasWinrateData(parseGame('(;GM[1]SZ[19];B[pd];W[dp])')), false)
})

test('parseGame: 摆子过滤虚着与越界坐标（tt / 小棋盘路数外）', () => {
  const game = parseGame('(;GM[1]SZ[9]AB[dd][tt][jj])')
  // 9 路只有 a..i：tt 是虚着，jj 越界，两者都丢
  assert.deepEqual(game.setup.black, ['dd'])
  assert.deepEqual(game.setup.white, [])
})

test('parseGame: LZ 属性解析（引擎/胜率/候选/PV，KataGo 坐标）', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  const move4 = game.moves[3] // W dd
  assert.equal(move4.analysis.lz.engine, 'KataGo-18b')
  assert.equal(move4.analysis.lz.winratePct, 22)
  assert.equal(move4.analysis.lz.scoreLeadOpponent, 28)
  assert.equal(move4.analysis.lz.candidates.length, 2)
  assert.equal(move4.analysis.lz.candidates[0].coord, 'C17')
  assert.equal(move4.analysis.lz.candidates[0].winratePer10000, 2200)
  assert.deepEqual(move4.analysis.lz.candidates[0].pv, ['C17', 'N17', 'D16', 'F6'])
})

test('parseGame: C[] 注释分析提取（第三方 GUI 注释格式，落子者视角约定）', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  const ca = game.moves[3].analysis.commentAnalysis
  assert.equal(ca.winratePct, 22)
  assert.equal(ca.winrateColor, 'white')
  assert.equal(ca.scoreLeadMover, -28)
  assert.equal(ca.engine, 'KataGo-18b')
  assert.equal(ca.playouts, '100')
})

test('parseGame: 无 C[] 仅 LZ 的节点也能提取（move 6）', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  const move6 = game.moves[5] // W nc
  assert.equal(move6.analysis.commentAnalysis, undefined)
  assert.equal(move6.analysis.lz.winratePct, 13)
})

test('winrateForMover: C[] 显式颜色 -> 落子者视角', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(winrateForMover(game.moves[0]), 0.5) // B pd, 黑 50%
  assert.ok(Math.abs(winrateForMover(game.moves[3]) - 0.22) < 1e-9) // W dd, 白 22%
})

test('winrateForColor: 任意颜色视角换算', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  const move8 = game.moves[7] // W dq，白 10%
  assert.ok(Math.abs(winrateForColor(move8, 'B') - 0.9) < 1e-9)
  assert.ok(Math.abs(winrateForColor(move8, 'W') - 0.1) < 1e-9)
})

test('winrateForMover: 仅 LZ 通道（落子者视角）', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(winrateForMover(game.moves[5]), 0.13) // W nc, LZ 13% = 白方 13%
})

test('scoreForMover: C[] 领先为落子者视角', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(scoreForMover(game.moves[3]), -28) // W dd，白方领先 -28
  assert.equal(scoreForMover(game.moves[0]), 0) // B pd，黑方领先 0
})

test('scoreForMover: LZ score 为对手视角（取负）', () => {
  const game = parseGame(readFixture('synthetic-analysis.sgf').toString('utf8'))
  assert.equal(scoreForMover(game.moves[5]), -37) // W nc，LZ 37（对手视角）-> 白 -37
})

test('parseGame: 虚着识别（B[]/W[]）', () => {
  const game = parseGame(readFixture('pass-game.sgf').toString('utf8'))
  assert.equal(game.moves.length, 4)
  assert.equal(game.moves[1].pass, true)
  assert.equal(game.moves[1].coord, null)
  assert.equal(game.moves[0].pass, false)
})

test('parseGame: 真实野狐棋谱（无分析，GBK/双重 mojibake 名）', () => {
  const buf = readFixture('[庄生梦1n4k]vs[V296646120]1788444401030026285.sgf')
  const { text } = decodeBuffer(buf)
  const game = parseGame(text)
  assert.equal(game.info.size, 19)
  assert.equal(game.info.komi, 3.75) // KM[375] 旧式百分制归一化
  assert.ok(game.moves.length > 50)
  assert.equal(typeof game.info.players.black, 'string')
  assert.ok(game.info.players.black.length > 0)
  assert.equal(game.info.rule, 'Chinese')
  assert.equal(game.info.result, 'B+R')
})

test('parseGame: 真实带分析棋谱', () => {
  const buf = readFixture('real-analysis.sgf')
  const { text } = decodeBuffer(buf)
  const game = parseGame(text)
  assert.equal(game.info.app, 'Lizzie: 2.5.3')
  assert.ok(game.moves.length >= 100, `应 >=100 手，实际 ${game.moves.length}`)
  const withAnalysis = game.moves.filter((m) => m.analysis && (m.analysis.lz || m.analysis.commentAnalysis)).length
  assert.ok(withAnalysis >= game.moves.length * 0.8, `带分析的手应占多数，实际 ${withAnalysis}/${game.moves.length}`)
})

test('parseLz: 单独调用（LZOP 格式）', () => {
  const lzop = 'KataGo-18b 5.7 968 6.6 14.9\nmove R16 visits 182 winrate 9434 prior 406 scoreMean 6.64 pv R16 D4 Q4 D17 info move R4 visits 182 winrate 9434 prior 406 scoreMean 6.64 pv R4 D16 info'
  const parsed = parseLz(lzop)
  assert.equal(parsed.engine, 'KataGo-18b')
  assert.equal(parsed.winratePct, 5.7)
  assert.equal(parsed.scoreLeadOpponent, 6.6)
  assert.equal(parsed.candidates.length, 2)
  assert.equal(parsed.candidates[0].coord, 'R16')
  assert.deepEqual(parsed.candidates[0].pv, ['R16', 'D4', 'Q4', 'D17'])
})

test('parseWinrateComment: 白方与 Move N 前缀', () => {
  const white = parseWinrateComment('Move 42 白棋 胜率: 30.5% (+2.1%)\n(KataGo-28b / 1.2k)')
  assert.equal(white.moveNumber, 42)
  assert.equal(white.winratePct, 30.5)
  assert.equal(white.winrateColor, 'white')
  assert.equal(white.engine, 'KataGo-28b')
})

test('parseWinrateComment: 无胜率的纯注释返回 null', () => {
  assert.equal(parseWinrateComment('这里应该出头。'), null)
})

test('coordLabel: 坐标转人类标签（跳过 I）', () => {
  assert.deepEqual(coordLabel('pd', 19), { label: 'Q16', pass: false, x: 15, y: 3 })
  assert.deepEqual(coordLabel('dd', 19), { label: 'D16', pass: false, x: 3, y: 3 })
  assert.deepEqual(coordLabel('dp', 19), { label: 'D4', pass: false, x: 3, y: 15 })
  assert.equal(coordLabel('tt', 19).pass, true)
  assert.equal(coordLabel('', 19).pass, true)
  assert.equal(coordLabel('jj', 19).label, 'K10')
})

test('kataCoordLabel: KataGo 坐标（R16 式）', () => {
  assert.deepEqual(kataCoordLabel('R16', 19), { label: 'R16', pass: false, x: 16, y: 3 })
  assert.deepEqual(kataCoordLabel('D4', 19), { label: 'D4', pass: false, x: 3, y: 15 })
  assert.equal(kataCoordLabel('tt', 19).label, 'tt')
})

test('coordList: 坐标序列转标签', () => {
  assert.equal(coordList(['pd', 'dp'], 19), 'Q16 D4')
})

// ---------------------------------------------------------------------------
// C[] 回写
// ---------------------------------------------------------------------------

const PLAIN = '(;GM[1]FF[4]SZ[19]KM[7.5]PB[黑]PW[白];B[pd];W[dp];B[qp];W[dd])'

test('injectComments: 无注释节点插入新 C[]', () => {
  const { text, written, missing } = injectComments(PLAIN, [{ moveNumber: 3, comment: '你好' }])
  assert.deepEqual(written, [3])
  assert.deepEqual(missing, [])
  assert.ok(text.includes(';B[qp]C[你好]'), text)
})

test('injectComments: 合并已有 C[]（换行追加）', () => {
  const withC = '(;GM[1];B[pd];W[dp];B[qp]C[旧注释];W[dd])'
  const { text, written } = injectComments(withC, [{ moveNumber: 3, comment: '新注释' }])
  assert.deepEqual(written, [3])
  // 语义断言：合并后该手读回应同时含旧、新注释（输出为重新序列化的 SGF，
  // 不再逐字节保留原排版；详见 injectComments 文档注释）。
  const back = parseGame(text).moves[2].analysis.comment
  assert.ok(back.includes('旧注释'), `读回=${JSON.stringify(back)}`)
  assert.ok(back.includes('新注释'))
  assert.ok(back.indexOf('旧注释') < back.indexOf('新注释'), '旧注释在前')
})

test('injectComments: 注释转义 ] 与 \\', () => {
  const { text } = injectComments(PLAIN, [{ moveNumber: 1, comment: 'a]b\\c' }])
  assert.ok(text.includes('C[a\\]b\\\\c]'), text)
})

test('injectComments: 超出手数的手记入 missing 且原文不变', () => {
  const { text, written, missing } = injectComments(PLAIN, [{ moveNumber: 99, comment: 'x' }])
  assert.deepEqual(written, [])
  assert.deepEqual(missing, [99])
  assert.equal(text, PLAIN)
})

test('injectComments: 虚着节点（B[]）后插入', () => {
  const passGame = '(;GM[1];B[pd];W[];B[dp])'
  const { text, written } = injectComments(passGame, [{ moveNumber: 2, comment: '停一手' }])
  assert.deepEqual(written, [2])
  assert.ok(text.includes(';W[]C[停一手]'), text)
})

test('injectComments: 变化图与主线在写回后均按树结构保留', () => {
  // 注意本夹具的树形状：`;W[dd]` 写在两个分支之后，属于 ;B[pd] 的**另一个子节点**，
  // 不是分支的延续。主线 = 第一个子节点路径 = W[dp],B[qp]（共 3 手）。
  const withVariation = '(;GM[1];B[pd](;W[dp];B[qp])(;W[cp];B[cq]);W[dd])'
  const { text, written } = injectComments(withVariation, [{ moveNumber: 2, comment: '主变' }])
  assert.deepEqual(written, [2])
  const game = parseGame(text)
  assert.equal(game.moves.length, 3, '第一条子节点路径不丢')
  assert.equal(game.stats.variations, 1, '变化图不丢')
  assert.equal(game.moves[1].analysis.comment, '主变')
  // 树结构未被破坏：重新解析后仍有两个分支
  const reparsed = parseGame(text)
  assert.equal(reparsed.stats.variations, 1)
})

// 回归：带分析棋谱把实战进行写成第一个子节点，形如 `](;B[de]…)(;B[fd]…)`。
// 早期字符扫描把每个 '(' 都当旁支跳过，导致分叉点之后的手数全部判为不存在：
// 106 手的真实棋谱只认到第 14 手（write-back 覆盖率 13%）。
test('injectComments: 变叉之后的手数仍可写回（早期只认到第 14 手）', () => {
  const real = readFileSync(fixture('real-analysis.sgf'), 'utf8')
  const game = parseGame(real)
  assert.equal(game.moves.length, 106)
  assert.equal(game.stats.variations, 2)
  const last = game.moves.length
  const r = injectComments(real, [
    { moveNumber: 21, comment: '分叉之后' },
    { moveNumber: last, comment: '末手' },
  ])
  assert.deepEqual(r.written, [21, last], '分叉之后的手数必须可写')
  assert.deepEqual(r.missing, [])
  const back = parseGame(r.text)
  assert.equal(back.moves.length, 106, '写回后手数不变')
  assert.equal(back.stats.variations, 2, '写回后变化图不变')
  assert.ok(back.moves[20].analysis.comment.includes('胜率'), '原有分析注释保留')
  assert.ok(back.moves[20].analysis.comment.includes('分叉之后'), '新讲解已追加')
  assert.equal(back.moves[last - 1].analysis.comment, '末手')
})

test('injectComments: 多条注释按手数定位且顺序正确', () => {
  const { text, written } = injectComments(PLAIN, [
    { moveNumber: 2, comment: '第二手' },
    { moveNumber: 1, comment: '第一手' },
  ])
  assert.deepEqual([...written].sort((a, b) => a - b), [1, 2])
  assert.ok(text.includes(';B[pd]C[第一手]'))
  assert.ok(text.includes(';W[dp]C[第二手]'))
})

test('injectComments: replace 覆盖原注释', () => {
  const withC = '(;GM[1];B[pd];W[dp]C[旧的];B[qp])'
  const { text, written } = injectComments(withC, [{ moveNumber: 2, comment: '全新' }], { replace: true })
  assert.deepEqual(written, [2])
  assert.ok(text.includes(';W[dp]C[全新]'), text)
  assert.ok(!text.includes('旧的'))
})

test('injectComments: 回写结果可被 @sabaki/sgf 重新解析', async () => {
  const sgf = (await import('@sabaki/sgf')).default
  const { text } = injectComments(PLAIN, [
    { moveNumber: 1, comment: '黑第一手' },
    { moveNumber: 4, comment: '白第四手' },
  ])
  const trees = sgf.parse(text)
  assert.equal(trees.length, 1)
  // 主变化线第 1 手（root 之后第一个子节点）
  const root = trees[0]
  const m1 = root.children[0]
  const m1c = m1.data instanceof Map ? m1.data.get('C') : m1.data.C
  assert.equal(m1c[0], '黑第一手')
  const m4 = m1.children[0].children[0].children[0]
  const m4c = m4.data instanceof Map ? m4.data.get('C') : m4.data.C
  assert.equal(m4c[0], '白第四手')
})
