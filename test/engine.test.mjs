// test/engine.test.mjs — engine.js 单测（JSON 查询构造 / 输出解析）
// 真实引擎集成测试由环境变量 KATAGO_PATH 门控（无引擎环境自动跳过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseGame } from '../src/sgf.js'
import { buildKataJsonQuery, parseKataAnalysisOutput, runKataAnalyze, normalizeKomi, extractKataErrors, readWinrateFrame } from '../src/engine.js'
import { resolveEngine, PACKAGE_DIR } from '../src/engine-resolve.js'

const GAME = parseGame('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese];B[pd];W[dp];B[qp];W[dd])')

// 回归：胜率口径。KataGo analysis 的 winrate 视角由 reportAnalysisWinratesAs 决定，
// 实测本机 analysis_example.cfg 设为 BLACK（固定黑方视角）。早期实现无条件按
// 「行棋方视角」取反，导致补算出的胜率被算反、落差虚高到 98%（荒谬值）。
test('readWinrateFrame: 解析 reportAnalysisWinratesAs', () => {
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs = BLACK'), 'black')
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs=SELF'), 'mover')
  // WHITE 是固定白方视角，与 SIDETOMOVE 不是一回事（2026-09-19 起单独识别）
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs = WHITE'), 'white')
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs = SIDETOMOVE'), 'mover')
  assert.equal(readWinrateFrame(''), 'mover', '未设置时 KataGo 默认 SIDETOMOVE（行棋方视角）')
  assert.equal(readWinrateFrame('# 没有该键\nfoo = 1'), 'mover')
})

test('readWinrateFrame: 命令行 override 优先于配置文件', () => {
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs = BLACK', 'reportAnalysisWinratesAs=SELF'), 'mover')
  assert.equal(readWinrateFrame('reportAnalysisWinratesAs = SELF', 'reportAnalysisWinratesAs=BLACK'), 'black')
})

// 补算合成后的完整性在真机测试里验证（见文件末尾，engineAvailable 之后）

// 回归：验收时实测到 KataGo 对 komi 的要求是整数/半整数且在 [-150,150]，
// 否则整条查询被拒，且报错把 field 写成 "rules"（极易误判为规则字符串问题）。
// 触发场景：旧式/异常 SGF 的 KM[375] 经解析归一化后得到 3.75。
test('normalizeKomi: 非半整数吸附（KM[375] 归一化出的 3.75）', () => {
  assert.equal(normalizeKomi(3.75), 4)
  assert.equal(normalizeKomi(3.8), 4)
  assert.equal(normalizeKomi(3.2), 3)
  assert.equal(normalizeKomi(7.5), 7.5)
  assert.equal(normalizeKomi(0), 0)
  assert.equal(normalizeKomi(-6.5), -6.5)
})

test('normalizeKomi: 越界夹取与缺失回落', () => {
  assert.equal(normalizeKomi(999), 150)
  assert.equal(normalizeKomi(-999), -150)
  assert.equal(normalizeKomi(undefined), 7.5)
  assert.equal(normalizeKomi(NaN), 7.5)
})

test('normalizeKomi: 结果恒为整数或半整数且在合法区间', () => {
  for (const v of [0.1, 0.25, 3.75, 6.3, 7.49, -0.3, 150.4, -200, 12.13]) {
    const k = normalizeKomi(v)
    assert.ok(Math.abs(k * 2 - Math.round(k * 2)) < 1e-9, `${v} -> ${k} 不是半整数`)
    assert.ok(k >= -150 && k <= 150, `${v} -> ${k} 越界`)
  }
})

test('buildKataJsonQuery: 脏贴目被规整为合法值（KM[375] 场景）', () => {
  // KM[375] 经解析的 >20 百分制启发式得到 3.75，旧实现原样发给引擎会被拒
  const dirty = parseGame('(;GM[1]FF[4]SZ[19]KM[375]RU[Chinese];B[pd];W[dp])')
  assert.equal(dirty.info.komi, 3.75)
  const q = JSON.parse(buildKataJsonQuery(dirty, 1, 2, 10).trim())
  assert.equal(q.komi, 4, '发出前必须规整为半整数')
  assert.ok(Math.abs(q.komi * 2 - Math.round(q.komi * 2)) < 1e-9)
})

test('extractKataErrors: 提取引擎错误行', () => {
  const stdout = [
    '{"error":"Must be a integer or half-integer from -150.0 to 150.0","field":"rules","id":"go-sensei"}',
    '{"error":"Must be a integer or half-integer from -150.0 to 150.0","field":"rules","id":"go-sensei"}',
    '{"id":"go-sensei","turnNumber":1,"moveInfos":[{"move":"Q16","order":0}]}',
  ].join('\n')
  const msg = extractKataErrors(stdout)
  assert.ok(msg.includes('half-integer'))
  assert.ok(msg.includes('field=rules'))
  assert.equal(extractKataErrors('{"id":"x","turnNumber":1,"moveInfos":[]}'), undefined)
  assert.equal(extractKataErrors(''), undefined)
  assert.equal(extractKataErrors('not json at all'), undefined)
})

// 回归：引擎对每条查询都回错误行、进程仍以 0 退出时，绝不能当成"补算成功但无问题手"。
test('runKataAnalyze: 引擎全量拒绝查询时报错而非静默返回空结果', async () => {
  const fakeSpawn = () => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: '{"error":"Must be a integer or half-integer from -150.0 to 150.0","field":"rules","id":"go-sensei"}\n', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
  })
  await assert.rejects(
    () => runKataAnalyze(fakeSpawn, { kataGoPath: 'x', game: GAME, from: 1, to: 2, maxVisits: 10 }),
    /KataGo 拒绝了补算查询/,
  )
})

test('runKataAnalyze: 正常响应时不抛错（即便没有问题手）', async () => {
  const okLine = '{"id":"go-sensei","isDuringSearch":false,"turnNumber":1,"moveInfos":[{"move":"Q16","order":0,"winrate":0.5,"scoreMean":0,"visits":10,"pv":["Q16"]}],"rootInfo":{"winrate":0.5,"scoreLead":0,"visits":10}}\n'
  const fakeSpawn = () => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: okLine, nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
  })
  const r = await runKataAnalyze(fakeSpawn, { kataGoPath: 'x', game: GAME, from: 1, to: 1, maxVisits: 10 })
  assert.equal(typeof r.moves, 'number')
  assert.ok(Array.isArray(r.candidates))
})

test('buildKataJsonQuery: 基本结构', () => {
  const q = JSON.parse(buildKataJsonQuery(GAME, 1, 3, 50).trim())
  assert.equal(q.id, 'go-sensei')
  assert.equal(q.rules, 'chinese')
  assert.equal(q.komi, 7.5)
  assert.equal(q.maxVisits, 50)
  assert.equal(q.boardXSize, 19)
  assert.deepEqual(q.moves, [['B', 'Q16'], ['W', 'D4'], ['B', 'R4']])
  assert.deepEqual(q.analyzeTurns, [1, 2, 3])
})

test('buildKataJsonQuery: 日本规则映射', () => {
  const jp = parseGame('(;GM[1]FF[4]SZ[19]RU[Japanese]KM[6.5];B[pd])')
  const q = JSON.parse(buildKataJsonQuery(jp, 1, 1, 10).trim())
  assert.equal(q.rules, 'japanese')
})

test('buildKataJsonQuery: 让子棋谱 initialStones 与 turn 偏移', () => {
  const game = parseGame('(;GM[1]FF[4]SZ[19]HA[4]KM[0.5]RU[Chinese];B[pd];B[dp];B[pp];W[dd];B[qp])')
  const q = JSON.parse(buildKataJsonQuery(game, 4, 5, 10).trim())
  assert.equal(q.initialPlayer, 'W')
  assert.equal(q.initialStones.length, 4)
  assert.deepEqual(q.moves, [['W', 'D16'], ['B', 'R4']])
  assert.deepEqual(q.analyzeTurns, [1, 2])
})

test('buildKataJsonQuery: 区间全部位于摆子内时报错', () => {
  const game = parseGame('(;GM[1]FF[4]SZ[19]HA[4]KM[0.5]RU[Chinese];B[pd];B[dp];B[pp];W[dd])')
  assert.throws(() => buildKataJsonQuery(game, 1, 2, 10), /摆子/)
})

test('buildKataJsonQuery: 虚着映射为 pass', () => {
  const game = parseGame('(;GM[1]FF[4]SZ[19]KM[7.5];B[pd];W[];B[qp])')
  const q = JSON.parse(buildKataJsonQuery(game, 1, 3, 10).trim())
  assert.deepEqual(q.moves, [['B', 'Q16'], ['W', 'pass'], ['B', 'R4']])
})

test('parseKataAnalysisOutput: 真实引擎响应解析（turnNumber 在响应顶层）', () => {
  const stdout = [
    '{"id":"t1","turnNumber":1,"moveInfos":[{"move":"D4","order":0,"pv":["D4","C3","C4"],"scoreLead":-0.9,"scoreMean":-0.9,"scoreStdev":14.4,"visits":3,"winrate":0.38}]}',
    '{"id":"t1","turnNumber":2,"moveInfos":[{"move":"R4","order":0,"pv":["R4","D4"],"scoreLead":0.2,"scoreMean":0.2,"scoreStdev":14.1,"visits":5,"winrate":0.52},{"move":"D4","order":1,"pv":["D4"],"scoreLead":0.1,"scoreMean":0.1,"scoreStdev":13.9,"visits":2,"winrate":0.51}]}',
  ].join('\n')
  const byMove = parseKataAnalysisOutput(stdout)
  assert.equal(byMove.size, 2)
  // 每个 turn 保留**全部**候选（按 order 升序），不再是单一最优条目
  assert.equal(byMove.get(1).length, 1)
  assert.equal(byMove.get(1)[0].move, 'D4')
  assert.equal(byMove.get(2).length, 2)
  assert.equal(byMove.get(2)[0].move, 'R4')
  assert.equal(byMove.get(2)[1].move, 'D4')
  assert.equal(byMove.get(2)[0].pv.length, 2)
})

test('parseKataAnalysisOutput: 同一 turn 多次响应按 order 合并且取更完整条目', () => {
  const stdout = [
    // 第一次：D4 只有 2 visits；第二次：同一 order 更新为 9 visits
    '{"id":"t","turnNumber":5,"moveInfos":[{"move":"D4","order":0,"pv":["D4"],"scoreMean":1,"visits":2,"winrate":0.5}]}',
    '{"id":"t","turnNumber":5,"moveInfos":[{"move":"D4","order":0,"pv":["D4","C3"],"scoreMean":1,"visits":9,"winrate":0.5},{"move":"Q16","order":1,"pv":["Q16"],"scoreMean":0.5,"visits":3,"winrate":0.49}]}',
  ].join('\n')
  const byMove = parseKataAnalysisOutput(stdout)
  assert.equal(byMove.get(5).length, 2)
  assert.equal(byMove.get(5)[0].visits, 9, '同 order 应保留 visits 更多的条目')
  assert.deepEqual(byMove.get(5)[0].pv, ['D4', 'C3'])
  assert.equal(byMove.get(5)[1].move, 'Q16')
})

test('parseKataAnalysisOutput: 跳过 pass/resign 与噪声行', () => {
  const stdout = [
    'KataGo v1.16.4',
    '{"id":"x","isDuringSearch":true,"moveInfos":[{"move":"pass","order":0,"pv":[],"scoreLead":0,"scoreMean":0,"visits":1,"winrate":0.5,"turnNumber":1}]}',
    'not json at all',
    '{"id":"x","isDuringSearch":false,"moveInfos":[{"move":"D4","order":0,"pv":["D4"],"scoreLead":1,"scoreMean":1,"visits":4,"winrate":0.6,"turnNumber":1}]}',
  ].join('\n')
  const byMove = parseKataAnalysisOutput(stdout)
  assert.equal(byMove.size, 1)
  assert.equal(byMove.get(1).length, 1)
  assert.equal(byMove.get(1)[0].move, 'D4')
})

// 真实引擎集成测试（需要本机 KataGo；无 KATAGO_PATH 时跳过）
const KATAGO_PATH = process.env.KATAGO_PATH
// 默认用随包分发的引擎：任何人 clone 后都能跑真机测试，不再依赖某台机器的路径。
const bundled = resolveEngine({ engineDir: join(PACKAGE_DIR, 'engine') })
const realKataGo = KATAGO_PATH ?? bundled.kataGoPath
const realConfig = bundled.configPath
const realModel = bundled.modelPath

function spawnSyncAdapter(exe, config, model) {
  return (spec) => {
    const result = spawnSync(exe, spec.argv.slice(1), {
      input: spec.stdio.stdin.data,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 480000,
      cwd: spec.cwd || undefined,
    })
    if (result.error) {
      return {
        pid: result.pid,
        done: Promise.resolve({ exitCode: 1, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: result.stdout ?? '', nextOffset: 0, lossy: false }) },
          stderr: {
            readFrom: () => ({
              text: `${result.stderr ?? ''}\n[spawn error: ${result.error.code} ${result.error.message}]`,
              nextOffset: 0,
              lossy: false,
            }),
          },
        },
      }
    }
    return {
      pid: result.pid,
      done: Promise.resolve({ exitCode: result.status, signal: result.signal }),
      collected: {
        stdout: { readFrom: () => ({ text: result.stdout ?? '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: result.stderr ?? '', nextOffset: 0, lossy: false }) },
      },
    }
  }
}

const engineAvailable = (() => {
  try {
    const r = spawnSync(realKataGo, ['version'], { encoding: 'utf8', timeout: 30000 })
    return r.status === 0
  } catch {
    return false
  }
})()

test('runKataAnalyze: 真机补算（需本机 KataGo，否则跳过）', { skip: !engineAvailable }, async () => {
  const result = await runKataAnalyze(spawnSyncAdapter(realKataGo, realConfig, realModel), {
    kataGoPath: realKataGo,
    configPath: realConfig,
    modelPath: realModel,
    game: GAME,
    from: 2,
    to: 4,
    maxVisits: 5,
  })
  assert.equal(result.engine, 'KataGo')
  assert.equal(result.moves, 3)
  assert.ok(result.seconds >= 0)
  assert.ok(Array.isArray(result.candidates))
  for (const c of result.candidates) {
    assert.ok(c.moveNumber >= 2 && c.moveNumber <= 4)
  }
})

// 补算合成的完整性：返回 merge 供 go_review_moves 的自动补算复用；
// 每手胜率必须落在 [0,100]（口径修错时最容易在这里越界）
test('runKataAnalyze: 返回合成棋局，每手胜率合法', { skip: !engineAvailable }, async () => {
  const result = await runKataAnalyze(spawnSyncAdapter(realKataGo, realConfig, realModel), {
    kataGoPath: realKataGo,
    configPath: realConfig,
    modelPath: realModel,
    game: GAME,
    from: 1,
    to: 3,
    maxVisits: 20,
  })
  assert.ok(result.merge !== undefined, '应返回合成后的棋局副本')
  assert.equal(result.merge.moves.length, GAME.moves.length)
  for (const m of result.merge.moves.slice(0, 3)) {
    const pct = m.analysis?.lz?.winratePct
    assert.ok(pct === undefined || (pct >= 0 && pct <= 100), `第 ${m.number} 手胜率越界: ${pct}`)
  }
})

// ---------------------------------------------------------------------------
// 口径回归（用假 spawn 注入引擎 JSON，不依赖真机）
// ---------------------------------------------------------------------------

/** 用一段伪造的 KataGo stdout 驱动 runKataAnalyze；configText 决定胜率口径。 */
function runWithFakeEngine(stdout, configText, range) {
  const cfgPath = join(tmpdir(), `go-sensei-frame-${Math.random().toString(36).slice(2)}.cfg`)
  writeFileSync(cfgPath, configText, 'utf8')
  const spawn = () => ({
    pid: 1,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
  })
  return runKataAnalyze(spawn, {
    kataGoPath: 'katago.exe',
    configPath: cfgPath,
    modelPath: '',
    game: GAME,
    from: range.from,
    to: range.to,
    maxVisits: 100,
  }).finally(() => { try { rmSync(cfgPath) } catch { /* 忽略 */ } })
}

// 回归：候选点的 winrate 在 LZ 约定里记的是「该 turn 行棋方」视角，而引擎配置写死
// reportAnalysisWinratesAs = BLACK（固定黑方）。不换算就会出现同一手棋旁边
// 「头部落差（落子者视角）」与「候选百分比（黑方视角）」两个口径 —— 实测第 21 手
// 候选 F16 在参考分析棋谱里记 98.9%（白方视角），旧实现输出 1.1%。
test('runKataAnalyze: 候选点胜率换算到该 turn 行棋方视角', async () => {
  const stdout = [
    // turn2 = 白 dp 之后 → 行棋方为黑 → 黑方口径原样使用
    '{"id":"go-sensei","turnNumber":2,"rootInfo":{"winrate":0.70,"currentPlayer":"B"},"moveInfos":[{"move":"Q16","order":0,"visits":100,"winrate":0.70,"scoreMean":5,"prior":0.4255,"pv":["Q16","D4"]},{"move":"D4","order":1,"visits":50,"winrate":0.68,"scoreMean":4,"pv":["D4"]}]}',
    // turn3 = 黑 qp 之后 → 行棋方为白 → 必须取反（1 - 0.65 = 0.35）
    '{"id":"go-sensei","turnNumber":3,"rootInfo":{"winrate":0.65,"currentPlayer":"W"},"moveInfos":[{"move":"D17","order":0,"visits":100,"winrate":0.65,"scoreMean":4,"pv":["D17"]}]}',
  ].join('\n') + '\n'
  const result = await runWithFakeEngine(stdout, 'reportAnalysisWinratesAs = BLACK\n', { from: 1, to: 4 })

  const m2 = result.merge.moves[1].analysis.lz // 第 2 手 = 白 dp
  assert.equal(m2.candidates[0].coord, 'Q16')
  assert.equal(m2.candidates[0].winratePer10000, 7000, '行棋方为黑时沿用黑方口径')
  assert.equal(m2.candidates[1].winratePer10000, 6800)
  assert.equal(m2.candidates[0].scoreMean, 5, '候选目差同为该 turn 行棋方（黑）视角')
  // prior 必须保留：写回 LZ[] 时 parseLz 要求该字段，缺了整条候选行都读不回来
  assert.equal(m2.candidates[0].prior, 4255)
  assert.equal(m2.candidates[1].prior, 0, '引擎没给 prior 时兜底 0，不能是 undefined')

  const m3 = result.merge.moves[2].analysis.lz // 第 3 手 = 黑 qp
  assert.equal(m3.candidates[0].coord, 'D17')
  assert.equal(m3.candidates[0].winratePer10000, 3500, '行棋方为白时必须取反')
  assert.equal(m3.candidates[0].scoreMean, -4, '行棋方为白时候选目差取反（实测 real-analysis.sgf 同口径）')
})

// 回归：reportAnalysisWinratesAs 未设置（KataGo 默认 SELF）时，mi.winrate 是
// **该 turn 行棋方**的胜率；落子者视角一律取反即可，不能再按 moveColor 二次取反。
test('runKataAnalyze: frame=mover（SELF）时白方每手胜率不被二次取反', async () => {
  // turn2 = 白 dp 之后，行棋方为黑：SELF 下 0.70 是黑方胜率，落子者（白）应为 0.30
  const stdout = '{"id":"go-sensei","turnNumber":2,"rootInfo":{"winrate":0.70,"currentPlayer":"B"},"moveInfos":[{"move":"Q16","order":0,"visits":100,"winrate":0.70,"scoreMean":5,"pv":["Q16"]}]}\n'
  const result = await runWithFakeEngine(stdout, 'reportAnalysisWinratesAs = SELF\n', { from: 2, to: 2 })

  const lz = result.merge.moves[1].analysis.lz // 第 2 手 = 白 dp，落子者为白
  assert.equal(lz.winratePct, 30, '黑方 70% → 落子者（白）应为 30%')
  // 候选是该 turn 行棋方（黑）的着法，SELF 口径下原样使用
  assert.equal(lz.candidates[0].winratePer10000, 7000)
})
