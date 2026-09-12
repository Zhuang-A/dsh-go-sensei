// test/report.test.mjs — go_export_report 骨架报告与 format 参数
//
// 覆盖两处"说了没做"的收口：
//  1) 骨架报告必须真的汇总棋谱 C[] 里已写回的讲解（工具描述承诺"已写回注释"）
//  2) format 参数必须被真正读取并校验，而不是声明后静默忽略
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.mjs'
import { buildReportSkeleton, extractUserNotes } from '../src/tools.js'
import { parseGame, injectComments } from '../src/sgf.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (n) => join(here, 'fixtures', n)
const WORK = join(here, 'tmp-report')

const CFG = Config({ kataGoPath: '', engineDir: join(here, 'no-such-engine') })

function makeCtx(workspace) {
  const registered = new Map()
  const writes = []
  return {
    registered,
    writes,
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    fs: {
      async resolve(p, opts = {}) {
        const { resolve } = await import('node:path')
        const abs = resolve(opts.cwd ?? workspace, p)
        return { displayPath: abs, targetKey: abs }
      },
      async stat(t) {
        try { const s = readFileSync(t.displayPath); return { type: 'file', size: s.length } } catch { return undefined }
      },
      async readBytes(t) { return readFileSync(t.displayPath) },
      async writeText(target, content, _e, _s, sandboxPolicy) {
        writes.push({ path: target.displayPath, sandboxPolicy })
        mkdirSync(dirname(target.displayPath), { recursive: true })
        writeFileSync(target.displayPath, content, 'utf8')
        return { operation: 'create', version: 1 }
      },
    },
    get: (n) => (n === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) } : undefined),
    emit() {},
    // tools/result 观察者（面板路由用它记住工作区根）
    on() { return () => {} },
    logger: { warn() {} },
  }
}

const exec = (cwd) => ({ callId: 'c', name: 'go_export_report', arguments: {}, agent: { session: { header: { cwd } } }, signal: undefined })

// ---------------------------------------------------------------------------
// extractUserNotes：从混合注释里剔掉引擎分析行
// ---------------------------------------------------------------------------

test('extractUserNotes: 剔除引擎分析行，保留人写的讲解', () => {
  const comment = [
    '黑棋 胜率: 1.1% (-98.9%)',
    '领先: -14.2 (-46.2) 不确定度: 15.3',
    '(KataGo-18b / 1.0k 计算量)',
    '贴目: 0.0',
    '这手 F14 想在左边围模样，但忽略了右上还欠一手。',
  ].join('\n')
  const notes = extractUserNotes(comment)
  assert.deepEqual(notes, ['这手 F14 想在左边围模样，但忽略了右上还欠一手。'])
})

test('extractUserNotes: 多段讲解按原顺序保留', () => {
  const comment = [
    '白棋 胜率: 22.0% (±0.1%)',
    '领先: -28.0 (-27.5) 不确定度: 2.0',
    '(KataGo-18b / 100 计算量)',
    '贴目: 7.5',
    '第一段：这手吃亏。',
    '第二段：应该先补角。',
  ].join('\n')
  assert.deepEqual(extractUserNotes(comment), ['第一段：这手吃亏。', '第二段：应该先补角。'])
})

test('extractUserNotes: 纯分析注释返回空', () => {
  const comment = '黑棋 胜率: 94.3% (-0.1%)\n领先: 6.7 (+0.1) 不确定度: 14.8\n(KataGo-18b / 250 计算量)\n贴目: 0.0'
  assert.deepEqual(extractUserNotes(comment), [])
})

test('extractUserNotes: 讲解里含"胜率"字样不会被误删', () => {
  // 只有整行匹配分析形态才丢弃；这句话不是分析行，必须保留
  const comment = '黑棋 胜率: 5.7%\n这手之后胜率直接崩了，说明方向错了。'
  assert.deepEqual(extractUserNotes(comment), ['这手之后胜率直接崩了，说明方向错了。'])
})

test('extractUserNotes: 空/非字符串安全', () => {
  assert.deepEqual(extractUserNotes(''), [])
  assert.deepEqual(extractUserNotes(undefined), [])
  assert.deepEqual(extractUserNotes(null), [])
})

test('extractUserNotes: 真实带分析棋谱无讲解时取不到内容', () => {
  const game = parseGame(readFileSync(fixture('real-analysis.sgf'), 'utf8'))
  const withNotes = game.moves.filter((m) => extractUserNotes(m.analysis?.comment).length > 0)
  assert.equal(withNotes.length, 0, '原始分析谱里不应被误判出讲解')
})

// ---------------------------------------------------------------------------
// buildReportSkeleton：汇总已写回讲解
// ---------------------------------------------------------------------------

test('buildReportSkeleton: 未写回讲解时给出明确提示', () => {
  const game = parseGame(readFileSync(fixture('real-analysis.sgf'), 'utf8'))
  const md = buildReportSkeleton(game, CFG)
  assert.ok(md.includes('## 逐手讲解'))
  assert.ok(md.includes('棋谱中尚无复盘讲解'), '应提示尚无讲解')
  assert.ok(md.includes('## 问题手一览'))
})

test('buildReportSkeleton: 已写回的讲解被汇总进"逐手讲解"', () => {
  const src = readFileSync(fixture('real-analysis.sgf'), 'utf8')
  const { text } = injectComments(src, [
    { moveNumber: 21, comment: '第 21 手讲解：这手应该下在 F16。' },
    { moveNumber: 50, comment: '第 50 手讲解：偏保守。' },
  ])
  const game = parseGame(text)
  const md = buildReportSkeleton(game, CFG)
  assert.ok(md.includes('第 21 手讲解：这手应该下在 F16。'), '应含第 21 手讲解')
  assert.ok(md.includes('第 50 手讲解：偏保守。'), '应含第 50 手讲解')
  assert.ok(md.includes('### 第 21 手 黑 F14'), `应带手数/颜色/坐标小标题，实际报告片段：\n${md.slice(md.indexOf('## 逐手讲解'), md.indexOf('## 逐手讲解') + 300)}`)
  // 引擎分析行不得混入
  assert.ok(!md.includes('KataGo-18b / 1.0k 计算量'), '引擎分析行不应进报告')
  assert.ok(!md.includes('不确定度: 15.3'), '引擎分析行不应进报告')
})

test('buildReportSkeleton: 报告同时含问题手表格与讲解', () => {
  const src = readFileSync(fixture('real-analysis.sgf'), 'utf8')
  const { text } = injectComments(src, [{ moveNumber: 21, comment: '讲解内容 X' }])
  const md = buildReportSkeleton(parseGame(text), CFG)
  assert.ok(md.includes('| 手数 | 方 | 位置 | 标签 |'), '含问题手表头')
  assert.ok(md.includes('| 21 |'), '含第 21 手行')
  assert.ok(md.includes('讲解内容 X'))
})

// ---------------------------------------------------------------------------
// go_export_report：format 参数真正生效
// ---------------------------------------------------------------------------

test('go_export_report: format=markdown 正常导出', async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const ctx = makeCtx(WORK)
  apply(ctx, CFG)
  const r = await ctx.registered.get('go_export_report').execute(
    { path: fixture('synthetic-analysis.sgf'), format: 'markdown', outPath: 'ok.md' },
    exec(WORK),
  )
  assert.equal(r.generated, true)
  assert.ok(readFileSync(r.outPath, 'utf8').includes('围棋复盘报告'))
  rmSync(WORK, { recursive: true, force: true })
})

test('go_export_report: 不支持的 format 报错（而非静默忽略）', async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const ctx = makeCtx(WORK)
  apply(ctx, CFG)
  await assert.rejects(
    () => ctx.registered.get('go_export_report').execute(
      { path: fixture('synthetic-analysis.sgf'), format: 'html', outPath: 'bad.md' },
      exec(WORK),
    ),
    /暂不支持的报告格式/,
  )
  rmSync(WORK, { recursive: true, force: true })
})

test('go_export_report: format 大小写与空白容错', async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const ctx = makeCtx(WORK)
  apply(ctx, CFG)
  const r = await ctx.registered.get('go_export_report').execute(
    { path: fixture('synthetic-analysis.sgf'), format: '  MarkDown  ', outPath: 'case.md' },
    exec(WORK),
  )
  assert.equal(r.generated, true)
  rmSync(WORK, { recursive: true, force: true })
})

test('go_export_report: 端到端写回讲解后导出，报告含讲解', async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const target = join(WORK, 'game.sgf')
  writeFileSync(target, readFileSync(fixture('real-analysis.sgf')))
  const ctx = makeCtx(WORK)
  apply(ctx, CFG)

  await ctx.registered.get('go_write_review').execute(
    { path: 'game.sgf', entries: [{ moveNumber: 21, comment: '端到端讲解：F16 是要点。' }] },
    exec(WORK),
  )
  const r = await ctx.registered.get('go_export_report').execute(
    { path: 'game.sgf', outPath: 'out.md' },
    exec(WORK),
  )
  const md = readFileSync(r.outPath, 'utf8')
  assert.ok(md.includes('端到端讲解：F16 是要点。'), '导出报告应汇总刚写回的讲解')
  assert.ok(md.includes('### 第 21 手 黑 F14'))
  rmSync(WORK, { recursive: true, force: true })
})
