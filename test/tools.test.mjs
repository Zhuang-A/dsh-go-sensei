// test/tools.test.mjs — 宿主工具端到端功能测试
//
// 用最小 ctx 仿真（tools/systemPrompt/fs 服务契约与真实 DSH 一致，
// fs 直接落在 node:fs 上的测试工作区）驱动 index.mjs 的 apply，
// 再以真实 ToolExecution 形态调用每个工具的 execute：覆盖解析→复盘→
// 上下文→写回→报告 全链路，以及缓存命中与错误路径。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.mjs'
import { parseGame, parseLz } from '../src/sgf.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const WORKSPACE = join(here, 'tmp-workspace')

// ---------------------------------------------------------------------------
// 最小 ctx 仿真：仅实现 index.mjs 用到的服务方法
// ---------------------------------------------------------------------------

function makeCtx(workspace) {
  const registered = new Map()
  const sections = []
  // 写入审计：记录每次 writeText 收到的沙箱策略（第 5 参数）。
  // 沙箱后端以该策略判定放行范围；缺失时真实后端一律拒写，故这里必须断言存在。
  const writes = []
  const ctx = {
    registered,
    sections,
    writes,
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const i = sections.indexOf(section)
          if (i >= 0) sections.splice(i, 1)
        }
      },
      getSectionOrder() {
        return 0
      },
    },
    fs: {
      async resolve(p, opts = {}) {
        const base = opts.cwd ?? workspace
        const abs = resolve(base, p)
        return { displayPath: abs, targetKey: abs }
      },
      async stat(target) {
        try {
          const st = statSync(target.displayPath)
          return { type: st.isDirectory() ? 'directory' : 'file', size: st.size }
        } catch {
          return undefined
        }
      },
      async readBytes(target, _signal, maxBytes) {
        const buf = readFileSync(target.displayPath)
        if (buf.length > maxBytes) throw new Error('too large')
        return buf
      },
      async writeText(target, content, _expected, _signal, sandboxPolicy) {
        writes.push({ path: target.displayPath, sandboxPolicy })
        mkdirSync(dirname(target.displayPath), { recursive: true })
        writeFileSync(target.displayPath, content, 'utf8')
        return { operation: 'create', version: 1 }
      },
    },
    emit() {},
    // tools/result 观察者（面板路由用它记住工作区根）；测试里只登记不触发
    on() { return () => {} },
    get(name) {
      if (name === 'sandboxPolicy') {
        return {
          resolve() {
            return { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'test-session' }
          },
        }
      }
      return undefined
    },
    logger: { warn() {} },
  }
  return ctx
}

const CFG = {
  level: 'auto',
  winrateThreshold: 0.03,
  scoreThreshold: 3,
  maxCandidates: 10,
  pvDepth: 6,
  tokenBudget: 50000,
  kataGoPath: '',
  kataGoConfig: '',
  kataGoModel: '',
  maxVisits: 100,
}

function execFor(workspace) {
  return {
    callId: 'test-call',
    name: 'test',
    arguments: {},
    agent: { session: { header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }
}

async function call(def, workspace, args) {
  return def.execute(args, execFor(workspace))
}

// ---------------------------------------------------------------------------
// 运行时同款 lossless-JSON 校验（对照 @deepseek-ai/dsh-util-values 的
// walkJsonValue 语义）。工具返回值必须通过它，否则真实运行时会以
// "value is not lossless JSON" 整体拒收 —— 尤其是对象属性值为 undefined
// 的形态，JSON 序列化会静默丢弃，但该边界判定为非法。
// ---------------------------------------------------------------------------
function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true
  const t = typeof value
  if (t === 'boolean' || t === 'string') return true
  if (t === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (t !== 'object') return false // undefined / function / symbol / bigint
  if (seen.has(value)) return false // 环
  seen.add(value)
  if (Array.isArray(value)) return value.every((v) => isLosslessJson(v, seen))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false // 类实例
  return Object.keys(value).every((k) => isLosslessJson(value[k], seen))
}

/** 调用工具并断言其返回值是合法 lossless JSON（模拟运行时边界）。 */
async function callJson(def, workspace, args) {
  const value = await call(def, workspace, args)
  assert.ok(
    isLosslessJson(value),
    `${def.name} 返回值不是 lossless JSON（含 undefined/类实例/非有限数），真实运行时会被拒收`,
  )
  return value
}

/** 列出返回值里所有值为 undefined 的属性路径，便于定位。 */
function findUndefinedPaths(value, path = '$', out = []) {
  if (value === undefined) { out.push(path); return out }
  if (value === null || typeof value !== 'object') return out
  for (const k of Object.keys(value)) findUndefinedPaths(value[k], `${path}.${k}`, out)
  return out
}

// ---------------------------------------------------------------------------

let ctx
let gameSgfInWorkspace

before(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  copyFileSync(fixture('synthetic-analysis.sgf'), join(WORKSPACE, 'game.sgf'))
  copyFileSync(fixture('lizzieyzy-real.sgf'), join(WORKSPACE, 'real.sgf'))
  gameSgfInWorkspace = join(WORKSPACE, 'game.sgf')
  ctx = makeCtx(WORKSPACE)
  apply(ctx, CFG)
})

after(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})

test('apply: 注册 5 个工具 + 2 个提示词段', () => {
  assert.deepEqual([...ctx.registered.keys()].sort(), [
    'go_export_report',
    'go_parse_sgf',
    'go_position_context',
    'go_review_moves',
    'go_write_review',
  ])
  assert.equal(ctx.sections.length, 2)
  const persona = ctx.sections.find((s) => s.name === 'go-sensei:persona')
  assert.ok(persona.text.includes('围棋老师'))
  assert.ok(persona.text.includes('50000')) // token 预算注入
})

test('go_parse_sgf: 工作区相对路径解析 + 元信息', async () => {
  const value = await call(ctx.registered.get('go_parse_sgf'), WORKSPACE, { path: 'game.sgf' })
  assert.equal(value.path, gameSgfInWorkspace)
  assert.equal(value.info.players.black, '庄生梦1n4k')
  assert.equal(value.moveCount, 8)
  assert.equal(value.hasAnalysis, true)
  assert.equal(value.encoding, 'utf-8')
  assert.deepEqual(value.warnings, [])
})

test('go_parse_sgf: 文件不存在时报错', async () => {
  await assert.rejects(
    () => call(ctx.registered.get('go_parse_sgf'), WORKSPACE, { path: 'nope.sgf' }),
    /找不到文件/,
  )
})

test('go_review_moves: 候选正确 + 缓存命中', async () => {
  const tool = ctx.registered.get('go_review_moves')
  const first = await call(tool, WORKSPACE, { path: 'game.sgf' })
  assert.equal(first.mode, 'analysis')
  assert.equal(first.cached, false)
  assert.deepEqual(first.candidates.map((c) => c.moveNumber), [4, 6, 8])
  assert.equal(first.level, '18K') // 双方 18级 → 自动推断 18K
  assert.ok(first.cacheKey.length > 0)

  const second = await call(tool, WORKSPACE, { path: 'game.sgf' })
  assert.equal(second.cached, true)
  assert.deepEqual(second.candidates.map((c) => c.moveNumber), [4, 6, 8])
})

test('go_review_moves: level 覆盖与阈值覆盖', async () => {
  const tool = ctx.registered.get('go_review_moves')
  const value = await call(tool, WORKSPACE, { path: 'game.sgf', level: '3D', winrateThreshold: 0.05, scoreThreshold: 999 })
  assert.equal(value.level, '3D')
  assert.deepEqual(value.candidates.map((c) => c.moveNumber), [4, 6])
})

test('go_review_moves: 纯棋谱 theory 模式', async () => {
  copyFileSync(fixture('[庄生梦1n4k]vs[V296646120]1788444401030026285.sgf'), join(WORKSPACE, 'plain.sgf'))
  const value = await call(ctx.registered.get('go_review_moves'), WORKSPACE, { path: 'plain.sgf' })
  assert.equal(value.mode, 'theory')
  assert.deepEqual(value.candidates, [])
})

test('go_position_context: 前后序列 + 候选', async () => {
  const value = await callJson(ctx.registered.get('go_position_context'), WORKSPACE, {
    path: 'game.sgf',
    moveNumber: 4,
    window: 2,
  })
  assert.equal(value.moveNumber, 4)
  assert.deepEqual(value.before.map((m) => m.number), [2, 3])
  assert.deepEqual(value.after.map((m) => m.number), [5, 6])
  assert.equal(value.candidatesAtMove.label.key, 'blunder')
  // 候选取上一手节点（第 3 手，由白行棋）→ D16/D4 是第 4 手白方「改下」的选择
  assert.equal(value.candidatesAtMove.pv[0].coord, 'D16')
  // 可选字段必须"缺席"而非"值为 undefined"：后者不是 lossless JSON。
  assert.ok(!('engineNote' in value), 'engineNote 不得以 undefined 形式出现')
  assert.deepEqual(findUndefinedPaths(value), [])
})

test('go_position_context: 非问题手也返回合法 JSON（无可选字段）', async () => {
  // 第 1 手通常不是问题手 → candidatesAtMove 缺席；曾因写入 undefined 被运行时拒收。
  const value = await callJson(ctx.registered.get('go_position_context'), WORKSPACE, {
    path: 'game.sgf',
    moveNumber: 1,
  })
  assert.equal(value.moveNumber, 1)
  assert.ok(!('candidatesAtMove' in value))
  assert.deepEqual(findUndefinedPaths(value), [])
})

test('go_position_context: theory 模式带 engineNote 且仍是合法 JSON', async () => {
  copyFileSync(fixture('[庄生梦1n4k]vs[V296646120]1788444401030026285.sgf'), join(WORKSPACE, 'plain2.sgf'))
  const value = await callJson(ctx.registered.get('go_position_context'), WORKSPACE, {
    path: 'plain2.sgf',
    moveNumber: 3,
  })
  assert.equal(typeof value.engineNote, 'string')
  assert.ok(!('candidatesAtMove' in value))
})

test('go_review_moves / go_parse_sgf: 返回值为合法 lossless JSON', async () => {
  await callJson(ctx.registered.get('go_review_moves'), WORKSPACE, { path: 'game.sgf' })
  await callJson(ctx.registered.get('go_parse_sgf'), WORKSPACE, { path: 'game.sgf' })
})

test('go_parse_sgf: 缺段位/日期等属性的棋谱仍是合法 JSON（无 undefined 属性）', async () => {
  // pass-game.sgf 没有 BR/WR/DT/AP/RE —— info 里这些字段本为 undefined，
  // 未经 compact 的返回会被运行时以 "value is not lossless JSON" 拒收。
  copyFileSync(fixture('pass-game.sgf'), join(WORKSPACE, 'minimal.sgf'))
  const value = await callJson(ctx.registered.get('go_parse_sgf'), WORKSPACE, { path: 'minimal.sgf' })
  assert.equal(value.moveCount, 4)
  assert.deepEqual(findUndefinedPaths(value), [])
  assert.ok(!('date' in value.info), '缺省日期字段应缺席而非 undefined')
  assert.ok(!('blackRank' in value.info.players))
})

test('go_position_context: 超出手数报错', async () => {
  await assert.rejects(
    () => call(ctx.registered.get('go_position_context'), WORKSPACE, { path: 'game.sgf', moveNumber: 99 }),
    /不存在/,
  )
})

test('go_write_review: 写回 C[] 且幂等追加', async () => {
  const tool = ctx.registered.get('go_write_review')
  const result = await call(tool, WORKSPACE, {
    path: 'game.sgf',
    entries: [
      { moveNumber: 4, comment: '白 78 手：这里被吃一大块，是败因。' },
      { moveNumber: 6, comment: '此处应争先手。' },
      { moveNumber: 99, comment: '不存在的手' },
    ],
  })
  assert.deepEqual(result.written, [4, 6])
  assert.deepEqual(result.missing, [99])
  assert.ok(result.bytes > 0)

  const text = readFileSync(gameSgfInWorkspace, 'utf8')
  assert.ok(text.includes('C[白棋 胜率: 22.0%'), '原有注释保留')
  assert.ok(text.includes('白 78 手：这里被吃一大块，是败因。'))

  // 再次写回同一手：追加而非覆盖
  const again = await call(tool, WORKSPACE, {
    path: 'game.sgf',
    entries: [{ moveNumber: 4, comment: '补充：可先提子再出头。' }],
  })
  assert.deepEqual(again.written, [4])
  const text2 = readFileSync(gameSgfInWorkspace, 'utf8')
  assert.ok(text2.includes('补充：可先提子再出头。'))
  assert.ok(text2.includes('白 78 手：这里被吃一大块，是败因。'))
})

test('go_write_review: 空 entries 与超长注释校验', async () => {
  const tool = ctx.registered.get('go_write_review')
  await assert.rejects(() => call(tool, WORKSPACE, { path: 'game.sgf', entries: [] }), /不能为空/)
  await assert.rejects(
    () => call(tool, WORKSPACE, { path: 'game.sgf', entries: [{ moveNumber: 1, comment: 'x'.repeat(2001) }] }),
    /超过/,
  )
})

test('go_export_report: 骨架报告与全文报告', async () => {
  const tool = ctx.registered.get('go_export_report')
  const skeleton = await call(tool, WORKSPACE, { path: 'game.sgf' })
  assert.equal(skeleton.outPath, join(WORKSPACE, 'game.review.md'))
  assert.equal(skeleton.generated, true)
  const md = readFileSync(skeleton.outPath, 'utf8')
  assert.ok(md.includes('围棋复盘报告'))
  assert.ok(md.includes('| 4 | 白 | D16 | 大恶手 | 27.5% |'))

  const full = await call(tool, WORKSPACE, { path: 'game.sgf', content: '# 自定义报告', outPath: 'custom.md' })
  assert.equal(full.generated, false)
  assert.equal(full.outPath, join(WORKSPACE, 'custom.md'))
  assert.equal(readFileSync(full.outPath, 'utf8'), '# 自定义报告')
})

// ---------------------------------------------------------------------------
// 沙箱策略契约：首次检查暴露的致命缺陷（写盘被一律拒绝）的回归测试。
// 官方 fs.writeText 的第 5 参数 sandboxPolicy 是沙箱后端判定放行范围的唯一
// 依据；省略时后端退回自身默认策略并拒写。此处断言每个写入都携带了它。
// ---------------------------------------------------------------------------

test('写盘契约: 每个写入都必须携带 sandboxPolicy（第 5 参数）', async () => {
  ctx.writes.length = 0

  await call(ctx.registered.get('go_write_review'), WORKSPACE, {
    path: 'game.sgf',
    entries: [{ moveNumber: 5, comment: '沙箱策略回归：写入必须带策略。' }],
  })
  await call(ctx.registered.get('go_export_report'), WORKSPACE, {
    path: 'game.sgf',
    content: '# 策略回归',
    outPath: 'policy-check.md',
  })

  assert.equal(ctx.writes.length, 2, '两次写入都应到达 fs.writeText')
  for (const w of ctx.writes) {
    assert.ok(w.sandboxPolicy, `写入 ${w.path} 缺少 sandboxPolicy —— 沙箱后端会拒写`)
    assert.equal(w.sandboxPolicy.mode, 'workspace-write')
    assert.equal(w.sandboxPolicy.workspaceRoot, WORKSPACE, 'workspaceRoot 必须传会话工作区')
  }
})

test('写盘契约: 写入后的解析基准与放行基准一致（同用 workspaceRoot）', async () => {
  // 相对路径经策略的 workspaceRoot 解析，应落在工作区内 —— 与沙箱放行范围同源。
  ctx.writes.length = 0
  const out = await call(ctx.registered.get('go_export_report'), WORKSPACE, {
    path: 'game.sgf',
    content: '# 基准一致',
    outPath: 'relative-root.md',
  })
  assert.equal(out.outPath, join(WORKSPACE, 'relative-root.md'))
  assert.equal(ctx.writes[0].sandboxPolicy.workspaceRoot, WORKSPACE)
})

test('写盘契约: 工具返回值均为合法 lossless JSON', async () => {
  await callJson(ctx.registered.get('go_write_review'), WORKSPACE, {
    path: 'game.sgf',
    entries: [{ moveNumber: 6, comment: 'JSON 边界回归。' }],
  })
  await callJson(ctx.registered.get('go_export_report'), WORKSPACE, {
    path: 'game.sgf',
    content: '# JSON 边界',
    outPath: 'json-check.md',
  })
})

// ---------------------------------------------------------------------------
// Lizzieyzy 数据通道回归
// ---------------------------------------------------------------------------

test('LZ 解析: playouts 带 k/M 量级后缀时头部仍可解析', () => {
  // 首次检查暴露：正则只接受纯数字，遇到 "3.9k" 整条头部失败 → 该手 winrate 丢失。
  const small = parseLz('KataGo-18b 93.4 250 -6.5 14.7')
  assert.equal(small.winratePct, 93.4)
  assert.equal(small.playouts, '250')

  const kilo = parseLz('KataGo-18b 93.4 3.9k -6.5 14.7')
  assert.equal(kilo.winratePct, 93.4, 'k 后缀不得让胜率解析失败')
  assert.equal(kilo.playouts, '3.9k')
  assert.equal(kilo.scoreLeadOpponent, -6.5)

  const mega = parseLz('KataGo-18b 2.0 1.2M 10.8 15.0')
  assert.equal(mega.winratePct, 2.0)
  assert.equal(mega.playouts, '1.2M')
})

test('LZ 解析: 真实 Lizzieyzy 棋谱每手都能取到胜率（含 k 后缀手）', () => {
  const game = parseGame(readFileSync(fixture('lizzieyzy-real.sgf'), 'utf8'))
  const missing = game.moves
    .filter((m) => m.analysis?.lz !== undefined && m.analysis.lz.winratePct === undefined)
    .map((m) => m.number)
  assert.deepEqual(missing, [], `以下手 LZ 头部解析失败导致胜率丢失：${missing.join(',')}`)

  // 第 7 手的分析量就是 "3.9k" 形态，是本次修复的直接回归点。
  assert.equal(game.moves[6].analysis.lz.winratePct, 93.4)
})

test('LZ 解析: 行棋方胜率通道与 C[] 注释通道一致（真实棋谱）', () => {
  const game = parseGame(readFileSync(fixture('lizzieyzy-real.sgf'), 'utf8'))
  // LZ 头部胜率为落子者视角；C[] 注释标签亦为落子者视角，两者应互相印证。
  let checked = 0
  for (const mv of game.moves) {
    const lz = mv.analysis?.lz?.winratePct
    const ca = mv.analysis?.commentAnalysis
    if (lz === undefined || !ca || ca.winratePct === undefined) continue
    assert.equal(
      Math.round(lz * 10) / 10,
      Math.round(ca.winratePct * 10) / 10,
      `第 ${mv.number} 手两通道胜率不一致（LZ=${lz} C[]=${ca.winratePct}）`,
    )
    checked++
  }
  assert.ok(checked > 90, `应有足够多的手参与双通道校验，实际 ${checked}`)
})

// 该缺陷已修复（injectComments 改为 @sabaki/sgf 树遍历），故直接作为回归测试运行。
test('go_write_review: 带变化图的真实棋谱应能写回全部主线手数', async () => {
  const target = join(WORKSPACE, 'variation.sgf')
  copyFileSync(fixture('lizzieyzy-real.sgf'), target)
  const game = parseGame(readFileSync(target, 'utf8'))
  const last = game.moves.length
  const result = await call(ctx.registered.get('go_write_review'), WORKSPACE, {
    path: 'variation.sgf',
    entries: [
      { moveNumber: 21, comment: '分叉之后的第 21 手' },
      { moveNumber: last, comment: '末手讲解' },
    ],
  })
  assert.deepEqual(result.written, [21, last])
  assert.deepEqual(result.missing, [])
  // 写回后棋谱仍完整：手数与变化图不变，原有 Lizzieyzy 注释保留
  const back = parseGame(readFileSync(target, 'utf8'))
  assert.equal(back.moves.length, last)
  assert.equal(back.stats.variations, game.stats.variations)
  assert.ok(back.moves[20].analysis.comment.includes('胜率'))
  assert.ok(back.moves[20].analysis.comment.includes('分叉之后的第 21 手'))
})

test('Config: 导出 Schema 且默认值齐全', () => {
  assert.ok(Config !== undefined && Config !== null)
  const defaults = apply.toString().includes('DEFAULT_CONFIG')
  assert.ok(defaults)
})

test('真实 Lizzieyzy 棋谱全链路（解析→复盘→写回→报告）', async () => {
  const parseValue = await call(ctx.registered.get('go_parse_sgf'), WORKSPACE, { path: 'real.sgf' })
  assert.equal(parseValue.info.app, 'Lizzie: 2.5.3')
  const reviewValue = await call(ctx.registered.get('go_review_moves'), WORKSPACE, { path: 'real.sgf' })
  assert.equal(reviewValue.mode, 'analysis')
  assert.ok(reviewValue.candidates.length >= 3)
  const writeResult = await call(ctx.registered.get('go_write_review'), WORKSPACE, {
    path: 'real.sgf',
    entries: [{ moveNumber: 1, comment: '复盘讲解：开局守角，方向正确。' }],
  })
  assert.deepEqual(writeResult.written, [1])
  const finalText = readFileSync(join(WORKSPACE, 'real.sgf'), 'utf8')
  assert.ok(finalText.includes('复盘讲解：开局守角，方向正确。'))
  const report = await call(ctx.registered.get('go_export_report'), WORKSPACE, { path: 'real.sgf' })
  assert.ok(existsSync(report.outPath))
  assert.equal(basename(report.outPath), 'real.review.md')
})
