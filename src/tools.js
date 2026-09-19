// src/tools.js — 围棋复盘工具集（DeepGo Sensei）
//
// 以裸 JSON-Schema ToolDefinition 直接注册（官方 cookbook 认可的路径，
// 零 @deepseek-ai 值导入）。全部文件 I/O 走 ctx.fs 服务，遵守会话文件策略；
// 相对路径按调用会话工作区解析（exec.agent.session.header.cwd，与官方
// read/write 工具同一机制）。工具注册是 effect：随插件 fiber 自动反注册。

import {
  decodeBuffer,
  parseGame,
  injectComments,
  injectAnalysis,
  analysisEntriesOf,
  coordLabel,
  compactBoard,
  hasWinrateData,
  hasTerritoryData,
  territoryOfMove,
  MAX_SGF_CHARS,
} from './sgf.js'
import { reviewGame, inferLevel, RANKS } from './review.js'
import { ReviewCache, gameFingerprint } from './cache.js'
import { resolveEngine, describeEngine } from './engine-resolve.js'
import { senseiPathFor } from './derived.js'
import { parsePointLabel, parseSequence, parseMarks } from './diagram.js'
import { estimateTerritorySeries } from './territory.js'

/** 工具返回值的裁剪上限，防止异常棋谱撑爆上下文。 */
const MAX_MOVE_LIST = 400
const MAX_CANDIDATES_CAP = 50
const MAX_ENTRIES_PER_WRITE = 200
const MAX_COMMENT_CHARS = 2000
/** go_export_report 传入正文的上限（1 MB；一份 Markdown 报告远小于此）。 */
const MAX_REPORT_CHARS = 1024 * 1024

function sessionCwd(exec) {
  const agent = exec && exec.agent
  const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
  return cwd
}

/**
 * 编译沙箱策略解析器（对齐官方 dsh-tool-fs 的 FsSandboxController）。
 *
 * 沙箱后端以每次写入携带的 SandboxExecutionPolicy 作为越界判定的唯一依据；
 * 不传时后端退回自身默认策略，在 workspace-write 会话中一律报
 * "file access denied under workspace-write mode"。故写入必须显式携带本策略，
 * 并把策略的 workspaceRoot 同时用作路径解析的 cwd（与官方
 * sessionResolveOptions 同源），避免解析基准与放行基准不一致。
 *
 * @returns {() => object | undefined} 每次调用返回当前执行策略；未挂沙箱服务时返回 undefined
 */
function compileSandboxPolicy(ctx) {
  // 未挂载 confining 后端时该服务不存在，仅作可选读取（不可作为硬依赖）。
  // 把"服务缺席"与"服务不完整"一并当作缺席：宁可走 fail-closed 的写入拒绝，
  // 也不要在 service.resolve 上抛 TypeError 把工具调用打成内部错误。
  const service = ctx.get('sandboxPolicy')
  if (service === undefined || service === null || typeof service.resolve !== 'function') {
    ctx.logger?.warn?.(
      'go-sensei：未找到可用的 sandboxPolicy 服务；写入类工具将被拒绝（读取不受影响）',
    )
    return () => undefined
  }
  return (exec) => {
    const session = exec?.agent?.session
    return service.resolve(session !== undefined ? { session } : {})
  }
}

/**
 * 写入前的策略门禁：拿不到 sandboxPolicy 服务时**拒绝写入**。
 *
 * 为什么必须 fail-closed：写入若不带策略，沙箱后端会退回自身默认策略 ——
 * 在 workspace-write 会话里表现为"偶发被拒"，而在没有 confining 后端时则是
 * **绕过工作区限制**（等同把受限会话的写权限放大到无限制）。读取不受影响：
 * 读取本就不由 sandboxPolicy 约束，故只读工具照常工作（2026-09 复核）。
 *
 * @param {object|undefined} policy 已解析的执行策略
 * @returns {object} 同一个策略对象
 */
function requireSandboxPolicy(policy) {
  // 也要挡 null／非对象：`service.resolve()` 在某些会话下可能返回 null，而
  // `null === undefined` 为假 —— 少了这一句，写入会带着"空策略"落到 fs 后端，
  // 正是 fail-closed 要堵的那条路（2026-09 复审，静态扫描逮到）。
  if (policy === undefined || policy === null || typeof policy !== 'object') {
    throw new Error(
      'go-sensei：当前组合没有 sandboxPolicy 服务，写入被拒绝'
        + '（避免在无沙箱后端时绕过工作区限制）。读取类工具不受影响；'
        + '如需写回，请在带沙箱服务的 DSH 会话里执行。',
    )
  }
  return policy
}

function resolveOptions(exec, p, policy) {
  // 有策略时以它的 workspaceRoot 为基准（官方语义）；否则退回会话 cwd。
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
  // exec 可能缺席：面板路由触发的写回没有工具执行上下文（见 index.mjs 的 /review），
  // 早期写法直接取 exec.signal，TypeError 被调用方的 catch 吞掉 → 写回静默失效。
  return { ...(cwd !== undefined ? { cwd } : {}), signal: exec?.signal }
}

async function resolveRegularFile(ctx, exec, p, policy) {
  const target = await ctx.fs.resolve(p, resolveOptions(exec, p, policy))
  const info = await ctx.fs.stat(target, exec?.signal)
  if (info === undefined) throw new Error(`找不到文件：${p}`)
  if (info.type !== 'file') throw new Error(`不是普通文件：${p}`)
  return target
}

/**
 * 解析「工作文件」：源棋谱 P 的复盘产物写在同目录的 `P-sensei.sgf` 里。
 *
 * 这就是"源文件只读"的全部实现：**读**优先用已存在的副本（那才是上一次复盘的成果：
 * 分析数据 + 讲解注释），**写**一律落在副本（见 writeAnalysisBack / go_write_review）。
 * 副本不存在时两者都退回源文件本身。
 *
 * @returns {Promise<{ source: object, target: object, derived: boolean }>}
 *   source = 调用者给的那个文件的解析结果；target = 实际要读的文件
 */
async function resolveWorkingFile(ctx, exec, p, policy) {
  const source = await resolveRegularFile(ctx, exec, p, policy)
  const derivedPath = senseiPathFor(source.displayPath)
  if (derivedPath === source.displayPath) return { source, target: source, derived: false }
  const target = await ctx.fs.resolve(derivedPath, resolveOptions(exec, derivedPath, policy))
  const info = await ctx.fs.stat(target, exec?.signal)
  if (info === undefined || info.type !== 'file') return { source, target: source, derived: false }
  return { source, target, derived: true }
}

/** 复盘副本的写入目标（副本可以还不存在，故不用 resolveRegularFile）。 */
async function derivedTargetFor(ctx, exec, sourcePath, policy) {
  const derivedPath = senseiPathFor(sourcePath)
  return ctx.fs.resolve(derivedPath, resolveOptions(exec, derivedPath, policy))
}

async function readGameFile(ctx, exec, p, policy) {
  const { source, target, derived } = await resolveWorkingFile(ctx, exec, p, policy)
  const readText = async (t) => {
    // 读取上限与解析守卫同源（MAX_SGF_CHARS）：超限的文件在读盘这一步就被拒，
    // 不会先整份读进内存再交给解析器判（2026-09 复审）。
    const bytes = await ctx.fs.readBytes(t, exec.signal, MAX_SGF_CHARS)
    return decodeBuffer(bytes)
  }
  let used = target
  let { text, encoding } = await readText(target)
  let game
  try {
    game = parseGame(text)
  } catch (error) {
    if (!derived) throw error
    // 副本坏了（空文件 / 半截写入 / 被别的程序改坏）不能让整盘棋读不出来：退回源棋谱。
    // 之后若发生写回，目标仍由 sourcePath 推出的副本 —— 等于用源内容把副本重建一遍。
    const fallback = await readText(source)
    text = fallback.text
    encoding = fallback.encoding
    used = source
    game = parseGame(text)
  }
  // 原文留着：补算成功后要把它连同新增的分析属性一起写回（见 writeAnalysisBack）。
  // sourcePath 单独记着 —— 写回的目标永远由它推出（`-sensei` 副本），
  // 而不是"从哪个文件读的"（读的可能是上一轮的副本）。
  game._meta = {
    path: used.displayPath,
    sourcePath: source.displayPath,
    derived: used.displayPath !== source.displayPath,
    encoding,
    text,
  }
  return game
}

function displayPathOf(game) {
  return game._meta?.path ?? '?'
}

/** 写回目标（复盘副本）的路径；供工具返回值告知"到底写到哪个文件了"。 */
function writeBackPathOf(game) {
  return senseiPathFor(game._meta?.sourcePath ?? game._meta?.path ?? '')
}

function effectiveLevel(cfg, game, override) {
  if (override && RANKS.includes(override)) return override
  if (cfg.level !== 'auto') return cfg.level
  return inferLevel(game.info)
}

function textBlock(lines) {
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 递归清洗工具返回值，使其一定是 lossless JSON。
 *
 * 运行时（@deepseek-ai/dsh-util-values 的 walkJsonValue）拒收三类值，任一出现
 * 整次调用都会以 "value is not lossless JSON" 失败：
 *   1. `undefined`（JSON.stringify 会静默丢键，故本地不易发现）→ 剔除；
 *   2. `-0`（`Object.is(v, -0)` 判非法）→ 归一成 `0`；
 *   3. `NaN` / `±Infinity`（`!Number.isFinite(v)` 判非法）→ 剔除该键。
 * 第 2 条是实测踩出来的：引擎补算时 `round1(-0.0002 * 100)` 通过
 * `Math.round(-0.2)` 产出 `-0`，让 go_review_moves / go_engine_analyze 在
 * 有 KataGo 数据的局面下直接报错（纯棋谱反而正常）。见 src/review.js 的 round1。
 *
 * 这里是**出口兜底**：源头（review.js / engine.js）已各自归一，出口再兜一层，
 * 保证以后新增字段也不会把非法值带过边界。可选字段一律走这里清洗，
 * 而不是写成 `key: maybeUndefined`。
 * @template T
 * @param {T} value
 * @returns {T} 清洗后的副本（非对象值原样返回）
 */
export function compact(value) {
  if (Array.isArray(value)) {
    // 先逐项清洗再剔除：NaN/Infinity 会被清洗成 undefined，必须在这一步之后过滤，
    // 否则数组里会残留空洞（长度不变但元素为 undefined，同样非法）。
    return value.map((v) => compact(v)).filter((v) => v !== undefined)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Object.is(value, -0) ? 0 : value
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const cleaned = compact(v)
      if (cleaned === undefined) continue
      out[k] = cleaned
    }
    return out
  }
  return value
}

function candidatesText(candidates, level) {
  if (candidates.length === 0) return ['（本局未发现明显问题手）']
  return candidates.map((c) => {
    const parts = [
      `第 ${c.moveNumber} 手 ${c.color === 'B' ? '黑' : '白'} ${c.coordLabel ?? c.coord ?? ''}`,
      `标签：${c.label.label}`,
    ]
    if (c.winrateLoss !== undefined) parts.push(`胜率损失 ${c.winrateLoss}%`)
    if (c.scoreLoss !== undefined) parts.push(`目差损失 ${c.scoreLoss} 目`)
    if (c.pv && c.pv.length > 0) {
      parts.push(`AI 候选：${c.pv.map((p) => `${p.label}（胜率 ${p.winratePct}%，变化 ${p.pv}）`).join('；')}`)
    }
    return parts.join('；')
  })
}

function reviewToolValue(game, cfg, args) {
  const level = effectiveLevel(cfg, game, args.level)
  const opts = {
    winrateThreshold: args.winrateThreshold ?? cfg.winrateThreshold,
    scoreThreshold: args.scoreThreshold ?? cfg.scoreThreshold,
    pvDepth: args.pvDepth ?? cfg.pvDepth,
    maxPvCandidates: 3,
    minMove: args.from ?? 1,
    maxCandidates: Math.min(args.maxCandidates ?? cfg.maxCandidates, MAX_CANDIDATES_CAP),
  }
  const review = reviewGame(game, opts)
  if (args.to !== undefined) {
    review.candidates = review.candidates.filter((c) => c.moveNumber <= args.to)
  }
  return { review, level }
}

// ---------------------------------------------------------------------------
// 各工具定义
// ---------------------------------------------------------------------------

function goParseSgf(ctx, cfg, cache, policy) {
  return {
    name: 'go_parse_sgf',
    description:
      '解析 SGF 围棋棋谱：返回棋局元信息（黑白棋手/段位/贴目/让子/结果/规则）与主变化线每手序列（坐标、颜色、虚着）。支持野狐/弈城导出的 GBK 编码，以及 KataGo 分析属性（WV/DM/PV）与注释内胜率行等带分析的棋谱。**源棋谱只读**：若同目录已存在复盘副本 `<源名>-sensei.sgf`，读的就是副本（那才是上一次复盘的成果：分析数据 + 讲解注释），返回的 path 是实际读取的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          info: { type: 'object' },
          moveCount: { type: 'integer' },
          hasAnalysis: { type: 'boolean' },
          encoding: { type: 'string' },
          moves: { type: 'array', items: { type: 'object' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'info', 'moveCount', 'hasAnalysis', 'encoding', 'moves', 'warnings'],
      },
      render: (args, value) =>
        textBlock([
          `棋谱：${value.path}`,
          `黑 ${value.info.players.black ?? '?'}（${value.info.players.blackRank ?? '段位未知'}） vs 白 ${value.info.players.white ?? '?'}（${value.info.players.whiteRank ?? '段位未知'}）`,
          `棋盘 ${value.info.size} 路，贴目 ${value.info.komi}，让子 ${value.info.handicap}，规则 ${value.info.rule ?? '未知'}，结果 ${value.info.result ?? '未记录'}`,
          `共 ${value.moveCount} 手${value.hasAnalysis ? '，棋谱携带 AI 分析数据' : '，棋谱无 AI 分析数据（纯棋理复盘）'}`,
          ...value.warnings.map((w) => `⚠ ${w}`),
        ]),
    },
    async execute(args, exec) {
      const game = await readGameFile(ctx, exec, args.path, policy(exec))
      const warnings = []
      if (game.stats.games > 1) warnings.push(`文件包含 ${game.stats.games} 局棋谱，仅取第一局`)
      if (game.stats.variations > 0) warnings.push(`棋谱含 ${game.stats.variations} 个变化图（旁支）`)
      if (/[\ufffd]/.test(JSON.stringify(game.info.players))) warnings.push('棋手名存在编码异常字符，已尽力修复')
      return {
        path: displayPathOf(game),
        info: {
          size: game.info.size,
          komi: game.info.komi,
          handicap: game.info.handicap,
          result: game.info.result,
          date: game.info.date,
          rule: game.info.rule,
          app: game.info.app,
          players: game.info.players,
        },
        moveCount: game.moves.length,
        // 「有分析数据」＝能取到逐手胜率；只写注释不算（否则会让人以为不用补算）
        hasAnalysis: hasWinrateData(game),
        encoding: game._meta.encoding,
        moves: game.moves.slice(0, MAX_MOVE_LIST).map((m) => ({
          number: m.number,
          color: m.color,
          coord: m.coord,
          pass: m.pass,
          label: m.coord ? coordLabel(m.coord, game.info.size).label : '虚着',
        })),
        warnings,
      }
    },
  }
}

function goReviewMoves(ctx, cfg, cache, policy) {
  return {
    name: 'go_review_moves',
    description:
      '识别 SGF 棋谱中的问题手（胜率/目差落差超阈值的候选），返回按严重度排序的裁剪后列表（每手 ≤3 个 AI 候选点、PV 截断、数值 1 位小数、标签枚举：大恶手/失误/不精确）。无分析数据且引擎可用时自动用自带 KataGo 补算，并把逐手胜率/目差与 AI 首选/变化图写回（WV[]/DM[]/LZ[]，analysisWritten 字段报告写回了多少手与写到哪个文件）——**不覆盖源棋谱**：写入目标是同目录的 `<源名>-sensei.sgf` 副本。完全无分析数据且引擎不可用时返回 theory 模式（纯棋理复盘）。同一局面重复复盘命中缓存。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        from: { type: 'number', description: '起始手数（含），默认 1' },
        to: { type: 'number', description: '结束手数（含），默认最后一手' },
        winrateThreshold: { type: 'number', description: '胜率落差阈值（0~1 小数，默认 0.03）' },
        scoreThreshold: { type: 'number', description: '目差阈值（目，默认 3）' },
        maxCandidates: { type: 'number', description: '返回候选上限（默认取配置）' },
        level: { type: 'string', description: `讲解难度覆盖：${RANKS.join('/')}/auto` },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          mode: { type: 'string' },
          level: { type: 'string' },
          cached: { type: 'boolean' },
          cacheKey: { type: 'string' },
          candidates: { type: 'array', items: { type: 'object' } },
          summary: { type: 'object' },
          // 无分析数据时自动补算的结果（或失败原因）；有分析数据/未启用引擎时该键省略。
          // 注意：dsh-tools 只接受单一类型字符串，禁止写成 type: ['object', 'null']。
          autoEngine: { type: 'object' },
          // 本次补算写回棋谱的逐手分析（WV/DM + LZ 首选/变化图）：{ moves, missing }
          analysisWritten: { type: 'object' },
        },
        required: ['path', 'mode', 'level', 'cached', 'cacheKey', 'candidates', 'summary'],
      },
      render: (args, value) => {
        const lines = [
          `${value.cached ? '🔄 来自缓存（同局面已复盘过）' : '复盘结果'}：${value.path}`,
          `模式：${value.mode === 'analysis' ? 'AI 数据分析' : '纯棋理讲解（棋谱无分析数据）'}；讲解难度：${value.level}`,
        ]
        if (value.autoEngine !== null && value.autoEngine !== undefined) {
          if (value.autoEngine.failed !== undefined) {
            lines.push(`⚠ 自动补算失败，已降级为纯棋理讲解：${value.autoEngine.failed}`)
          } else {
            const model = typeof value.autoEngine.model === 'string' && value.autoEngine.model !== ''
              ? `，权重 ${value.autoEngine.model}`
              : ''
            lines.push(
              `🤖 棋谱原无分析数据，已自起 KataGo 补算第 ${value.autoEngine.from}~${value.autoEngine.to} 手`
              + `（${value.autoEngine.moves} 手 / ${value.autoEngine.seconds}s${model}）`,
            )
          }
        }
        if (value.analysisWritten !== null && value.analysisWritten !== undefined) {
          const w = value.analysisWritten
          if (typeof w.moves === 'number' && w.moves > 0) {
            lines.push(
              `💾 已把逐手胜率/目差与 AI 首选/变化图写回 ${w.path ?? '复盘副本'}（${w.moves} 手）`
              + '——源棋谱保持原样，副本与源棋谱同目录。',
            )
          } else if (w.failed !== undefined) {
            lines.push(`⚠ 分析写回失败（不影响本次复盘）：${w.failed}`)
          }
        }
        lines.push(...candidatesText(value.candidates, value.level))
        return textBlock(lines)
      },
    },
    async execute(args, exec) {
      const game = await readGameFile(ctx, exec, args.path, policy(exec))
      const key = cache.keyFor(game, {
        level: args.level ?? cfg.level,
        winrateThreshold: args.winrateThreshold ?? cfg.winrateThreshold,
        scoreThreshold: args.scoreThreshold ?? cfg.scoreThreshold,
        scope: 'review',
      })
      const cachedValue = cache.get(key)
      if (cachedValue !== undefined) return { ...cachedValue, cached: true, cacheKey: key }

      const from = Math.max(1, Math.trunc(args.from ?? 1))
      const totalMoves = game.moves.length
      const to = Math.min(totalMoves, Math.trunc(args.to ?? totalMoves))

      // 无分析数据 + 已配置引擎 → 自动补算，而不是降级成「未发现问题手」。
      // 任务书 §一 的数据侧就是两条路径，第二条正是「插件经 ctx.subprocess 自起
      // KataGo 对关键手补算」；靠人记得手动调 go_engine_analyze 不可靠。
      // 与面板数据路由共用 autoComputeIfNeeded，避免两套管线漂移。
      // 不设 autoEngine 时保持 undefined，由 compact 剔除该键（null 不会被剔除，
      // 且与 output schema 声明的单一 object 类型不符）。
      const { autoEngine } = await autoComputeIfNeeded(ctx, cfg, game, { from, to, signal: exec.signal })
      // 这次真的跑了引擎 → 把逐手分析写回棋谱，文件从此自带胜率/目差与首选/变化图，
      // 下次打开（面板或工具）都不必再算。缓存命中/本就有分析时不写。
      const analysisWritten = autoEngine !== undefined && autoEngine.failed === undefined && autoEngine.cached !== true
        ? await writeAnalysisBack(ctx, exec, policy(exec), game).catch(() => undefined)
        : undefined

      const { review, level } = reviewToolValue(game, cfg, args)
      const value = {
        path: displayPathOf(game),
        // 仅在有补算结果/失败原因时写入该键；否则交由 compact 剔除。
        ...(autoEngine !== undefined ? { autoEngine } : {}),
        ...(analysisWritten !== undefined ? { analysisWritten } : {}),
        mode: review.mode,
        level,
        cacheKey: key,
        candidates: review.candidates.map((c) =>
          compact({
            moveNumber: c.moveNumber,
            color: c.color,
            coord: c.coord,
            coordLabel: c.coordLabel,
            label: c.label,
            winrateLoss: c.winrateLoss,
            scoreLoss: c.scoreLoss,
            winrateBefore: c.winrateBefore,
            winrateAfter: c.winrateAfter,
            scoreBefore: c.scoreBefore,
            scoreAfter: c.scoreAfter,
            pv: c.pv,
            engine: c.engine,
            playouts: c.playouts,
            comment: c.comment,
          }),
        ),
        summary: compact(review.summary),
      }
      cache.set(key, value)
      return { ...value, cached: false }
    },
  }
}

function goPositionContext(ctx, cfg, cache, policy) {
  return {
    name: 'go_position_context',
    description:
      '获取某手前后的局面上下文：该手坐标与颜色、前后各 window 手的序列、该手若为问题手的 AI 候选与 PV、当前局面胜率/目差。供复盘追问（如"第 N 手改下 X 会怎样"）使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        moveNumber: { type: 'number', description: '要查看的手数（1-based）' },
        window: { type: 'number', description: '前后各取多少手（默认 6，上限 20）' },
        level: { type: 'string', description: `讲解难度覆盖：${RANKS.join('/')}/auto` },
      },
      required: ['path', 'moveNumber'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          moveNumber: { type: 'integer' },
          level: { type: 'string' },
          cached: { type: 'boolean' },
          position: { type: 'object' },
          before: { type: 'array', items: { type: 'object' } },
          after: { type: 'array', items: { type: 'object' } },
          candidatesAtMove: { type: 'object' },
          engineNote: { type: 'string' },
        },
        required: ['path', 'moveNumber', 'level', 'cached', 'position', 'before', 'after'],
      },
      render: (args, value) => {
        const move = value.position
        const lines = [
          `${value.cached ? '🔄 来自缓存。' : ''}第 ${move.number} 手 ${move.color === 'B' ? '黑' : '白'}${move.label ? ` 下在 ${move.label}` : '（虚着）'}。`,
          value.before.length > 0 ? `此前：${value.before.map((m) => `${m.number}(${m.label})`).join(' ')}` : '（第 1 手，无前序）',
          value.after.length > 0 ? `此后：${value.after.map((m) => `${m.number}(${m.label})`).join(' ')}` : '（已到末手）',
        ]
        const c = value.candidatesAtMove
        if (c && c.pv && c.pv.length > 0) {
          lines.push(`AI 候选：${c.pv.map((p) => `${p.label}（胜率 ${p.winratePct}%，变化 ${p.pv}）`).join('；')}`)
        }
        if (value.engineNote) lines.push(value.engineNote)
        return textBlock(lines)
      },
    },
    async execute(args, exec) {
      const game = await readGameFile(ctx, exec, args.path, policy(exec))
      const moveNumber = Math.trunc(args.moveNumber)
      if (moveNumber < 1 || moveNumber > game.moves.length) {
        throw new Error(`第 ${moveNumber} 手不存在：本局共 ${game.moves.length} 手`)
      }
      const level = effectiveLevel(cfg, game, args.level)
      const key = cache.keyFor(game, { level, scope: `context:${moveNumber}` })
      const cachedValue = cache.get(key)
      if (cachedValue !== undefined) return { ...cachedValue, cached: true }

      const windowSize = Math.min(Math.max(args.window ?? 6, 1), 20)
      const idx = moveNumber - 1
      const move = game.moves[idx]
      const fmt = (m) => ({
        number: m.number,
        color: m.color,
        coord: m.coord,
        label: m.coord ? coordLabel(m.coord, game.info.size).label : '虚着',
      })
      const review = reviewGame(game, {
        winrateThreshold: cfg.winrateThreshold,
        scoreThreshold: cfg.scoreThreshold,
        pvDepth: cfg.pvDepth,
        maxPvCandidates: 3,
        minMove: moveNumber,
        maxCandidates: 1,
      })
      const atMove = review.candidates.find((c) => c.moveNumber === moveNumber)

      let engineNote
      if (game.moves.every((m) => m.analysis === null)) {
        engineNote = '棋谱无 AI 分析数据；如需精确候选点，请配置 KataGo 后使用 go_engine_analyze 补算，或基于棋理讨论。'
      }

      const value = {
        path: displayPathOf(game),
        moveNumber,
        level,
        position: fmt(move),
        before: game.moves.slice(Math.max(0, idx - windowSize), idx).map(fmt),
        after: game.moves.slice(idx + 1, idx + 1 + windowSize).map(fmt),
        // 可选字段按需添加：属性值为 undefined 的对象不是 lossless JSON，
        // 会被工具运行时整体拒收（"value is not lossless JSON"）。
        ...(atMove
          ? {
              candidatesAtMove: {
                label: atMove.label,
                winrateLoss: atMove.winrateLoss,
                scoreLoss: atMove.scoreLoss,
                pv: atMove.pv,
              },
            }
          : {}),
        ...(engineNote !== undefined ? { engineNote } : {}),
      }
      cache.set(key, value)
      return { ...value, cached: false }
    },
  }
}

function goWriteReview(ctx, cfg, cache, policy) {
  return {
    name: 'go_write_review',
    description:
      '把讲解写回棋谱的 C[] 注释（任何能显示注释的打谱软件/App 都能看到）。**不覆盖源棋谱**：写入目标是同目录的 `<源名>-sensei.sgf`（副本不存在时创建，已存在则在其上继续追加）。entries 为 [{ moveNumber, comment }]，每局最多 200 条、单条 ≤2000 字；已有注释默认换行追加（replace=true 覆盖）。写入后请用 go_parse_sgf 复核。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              moveNumber: { type: 'number', description: '手数（1-based）' },
              comment: { type: 'string', description: '讲解文本（写入 C[]）' },
            },
            required: ['moveNumber', 'comment'],
          },
        },
        replace: { type: 'boolean', description: 'true 覆盖该手已有注释，默认追加' },
      },
      required: ['path', 'entries'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          sourcePath: { type: 'string' },
          derived: { type: 'boolean' },
          written: { type: 'array', items: { type: 'integer' } },
          missing: { type: 'array', items: { type: 'integer' } },
          skipped: { type: 'array', items: { type: 'integer' } },
          bytes: { type: 'integer' },
        },
        required: ['path', 'written', 'missing', 'skipped', 'bytes'],
      },
      render: (args, value) =>
        textBlock([
          `已写回 ${value.path}：成功 ${value.written.length} 条（第 ${value.written.join('、') || '无'} 手），`,
          `不存在的手 ${value.missing.length} 条${value.skipped.length > 0 ? `，跳过 ${value.skipped.length} 条` : ''}。`,
          ...(value.derived === true && typeof value.sourcePath === 'string'
            ? [`源棋谱 ${value.sourcePath} 保持原样，讲解与 AI 分析都攒在副本里。`]
            : []),
          '提示：用任意能显示 SGF 注释的打谱软件打开该棋谱即可看到注释；重复写回同一手会自动追加而非覆盖。',
        ]),
    },
    async execute(args, exec) {
      const entries = Array.isArray(args.entries) ? args.entries : []
      if (entries.length === 0) throw new Error('entries 不能为空')
      if (entries.length > MAX_ENTRIES_PER_WRITE) {
        throw new Error(`一次最多写 ${MAX_ENTRIES_PER_WRITE} 条注释，请分批写回`)
      }
      const cleaned = entries.map((e) => {
        const moveNumber = Math.trunc(Number(e?.moveNumber))
        const comment = String(e?.comment ?? '').trim()
        if (!Number.isFinite(moveNumber) || moveNumber < 1) throw new Error(`moveNumber 非法：${e?.moveNumber}`)
        if (comment === '') throw new Error(`第 ${moveNumber} 手注释为空`)
        if (comment.length > MAX_COMMENT_CHARS) throw new Error(`第 ${moveNumber} 手注释超过 ${MAX_COMMENT_CHARS} 字`)
        return { moveNumber, comment }
      })
      const sandboxPolicy = requireSandboxPolicy(policy(exec))
      // 走同一条读取规则（副本优先、坏副本退回源棋谱），拿原文注入注释
      const game = await readGameFile(ctx, exec, args.path, sandboxPolicy)
      const result = injectComments(game._meta.text, cleaned, { replace: args.replace === true })
      if (result.written.length === 0) {
        throw new Error(`没有写入任何注释：指定手数均不存在（${result.missing.join(', ') || '未知原因'}）`)
      }
      // 写：一律落到 `-sensei` 副本（源文件保持原样），副本不存在时由这次写入创建。
      const target = await derivedTargetFor(ctx, exec, game._meta.sourcePath, sandboxPolicy)
      const sourcePath = game._meta.sourcePath
      // 第 5 参数必须带沙箱策略，否则沙箱后端按自身默认策略拒写。
      await ctx.fs.writeText(target, result.text, undefined, exec.signal, sandboxPolicy)
      ctx.emit('fs/observed', target, { kind: 'present' }, exec)
      return {
        path: target.displayPath,
        sourcePath,
        derived: target.displayPath !== sourcePath,
        written: result.written,
        missing: result.missing,
        skipped: result.skipped,
        bytes: Buffer.byteLength(result.text, 'utf8'),
      }
    },
  }
}

function goExportReport(ctx, cfg, cache, policy) {
  return {
    name: 'go_export_report',
    description:
      '把复盘报告落盘为 Markdown（默认与**本次读取的棋谱**同目录、同名 .review.md；源棋谱有复盘副本时即 `<源名>-sensei.review.md`）。content 为报告全文；省略时自动生成骨架报告（棋局信息 + 问题手表格 + 已写回注释）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        content: { type: 'string', description: 'Markdown 报告全文（省略则自动生成骨架）' },
        outPath: { type: 'string', description: '报告输出路径（默认与棋谱同目录同名 .review.md）' },
        format: { type: 'string', description: "报告格式，当前仅支持 'markdown'（默认）；其他值报错" },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outPath: { type: 'string' },
          bytes: { type: 'integer' },
          generated: { type: 'boolean' },
        },
        required: ['outPath', 'bytes', 'generated'],
      },
      render: (args, value) =>
        textBlock([
          `报告已写入 ${value.outPath}（${value.bytes} 字节，${value.generated ? '自动生成骨架' : '使用提供的全文'}）。`,
          '提示：报告是对话的落盘副本；继续追问可再次导出覆盖。',
        ]),
    },
    async execute(args, exec) {
      // format 只支持 markdown：显式校验而非静默忽略（早期该参数声明了却从未被读取）。
      const format = args.format === undefined ? 'markdown' : String(args.format).trim().toLowerCase()
      if (format !== 'markdown') {
        throw new Error(`暂不支持的报告格式：${args.format}（当前仅支持 'markdown'）`)
      }
      const sandboxPolicy = requireSandboxPolicy(policy(exec))
      const game = await readGameFile(ctx, exec, args.path, sandboxPolicy)
      const outPath =
        args.outPath ??
        (() => {
          const base = displayPathOf(game)
          return base.replace(/\.sgf$/i, '') + '.review.md'
        })()
      const target = await ctx.fs.resolve(outPath, resolveOptions(exec, outPath, sandboxPolicy))
      const content = args.content !== undefined && String(args.content).trim() !== ''
        ? String(args.content)
        : buildReportSkeleton(game, cfg)
      // 传入的报告正文也要有上限：写入是唯一会让插件产生副作用的地方，不该由调用方
      // 决定写多大（2026-09 复审）。生成骨架走同一道检查，顺带保证两条路一致。
      if (content.length > MAX_REPORT_CHARS) {
        throw new Error(`报告内容过长：${content.length} 字符，上限 ${MAX_REPORT_CHARS} 字符`)
      }
      // 第 5 参数必须带沙箱策略，否则沙箱后端按自身默认策略拒写。
      await ctx.fs.writeText(target, content, undefined, exec.signal, sandboxPolicy)
      ctx.emit('fs/observed', target, { kind: 'present' }, exec)
      return {
        outPath: target.displayPath,
        bytes: Buffer.byteLength(content, 'utf8'),
        generated: !(args.content !== undefined && String(args.content).trim() !== ''),
      }
    },
  }
}

/**
 * 把「局面 + 变化图 + 重点棋子标注」画成一张配图，返回可直接嵌进回答的 Markdown 图片行。
 *
 * 形态选择：图片由宿主自注册的 `/go-sensei/diagram` 路由渲染成 SVG（参数即全部输入，
 * 无状态），工具只负责拼 URL。这样对话正文里一个 `![](http://…/go-sensei/diagram?…)`
 * 就能显示出盘面 —— 走的是聊天区对**绝对 http(s) 图片地址**的原生渲染，不碰任何内部接口。
 *
 * 为什么必须在回答里用返回的 markdown 字段：URL 由 Host 的 host:port 决定
 * （用户可能用 localhost / 局域网 IP 打开界面），模型自己拼一定会拼错。
 */
function goDrawDiagram(ctx, cfg, cache, policy, diagram) {
  return {
    name: 'go_draw_diagram',
    description:
      '为讲解生成一张棋盘配图（SVG），返回可在回答正文里直接使用的 Markdown 图片行 `![说明](URL)`。'
      + '用途：回答"第 N 手改下 X 会怎样""这里连没连上"这类追问时，用图说明变化与要点。'
      + '变化图着法按 1-9、A-Z 逐手编号（起始颜色按局面自动推断，也可写成 "B:Q16" 显式指定）；'
      + '重点棋子用 triangle（三角形）/ square / circle / cross / label（字母或数字）标出。'
      + 'territory=true 时叠加**形势判断**（引擎归属图判出的黑地/白地，未定处留白，'
      + '并在图下写出双方目数与领先），适合讲"这块地是谁的""现在谁领先"；'
      + '该手还没有归属数据时会当场补算一次（要等几十秒），引擎不可用时如实说明、不出图。'
      + '**回答里必须原样粘贴返回的 markdown 行**，URL 不要改写或另编。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        moveNumber: {
          type: 'number',
          description: '基准局面：第 N 手之后的盘面（省略＝末手；0＝开局）。想看"第 N 手改下哪"就填 N-1 或 N，取决于你要画的局面。',
        },
        sequence: {
          type: 'array',
          items: { type: 'string' },
          description: '变化图着法序列，逐手按 1-9、A-Z 编号。每项形如 "Q16"（按轮转自动定色）或 "B:Q16"（显式指定颜色，同时改变后续轮转）。',
        },
        marks: {
          type: 'array',
          items: { type: 'string' },
          description: '重点棋子标注，每项形如 "triangle:Q16"、"square:D4"、"circle:C10"、"cross:R6"、"label:Q16:A"（末尾可带一个字母/数字）。',
        },
        territory: {
          type: 'boolean',
          description: 'true 时在盘上叠加领地显示（简易形势判断：只挨黑子/只挨白子的空点画成黑/白小方块），并在图下附一行简易点目。讲地盘归属、形势优劣时用它。',
        },
        caption: { type: 'string', description: '图注（画在棋盘下方，一句话，如"黑 1 断后白无应手"）' },
        width: { type: 'number', description: '图片像素宽度（默认 640，范围 120~1600）' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          markdown: { type: 'string' },
          moveNumber: { type: 'integer' },
          size: { type: 'integer' },
          caption: { type: 'string' },
          numbered: { type: 'array', items: { type: 'string' } },
          marks: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          // 叠加了领地显示时，把那行形势判断也带回给模型（免得它自己算）
          territory: { type: 'string' },
          // 形势判断没能出图时的原因（引擎不可用、该手没有归属数据……）
          territoryNote: { type: 'string' },
        },
        required: ['url', 'markdown', 'moveNumber', 'size', 'caption', 'numbered', 'marks', 'skipped'],
      },
      render: (args, value) => {
        const lines = [
          `🖼 配图已生成：第 ${value.moveNumber} 手之后的局面（${value.size} 路）`
          + (value.numbered.length > 0 ? `，变化图 ${value.numbered.length} 手` : '')
          + (value.marks.length > 0 ? `，标注 ${value.marks.length} 处` : ''),
        ]
        if (value.numbered.length > 0) lines.push(`变化：${value.numbered.join(' → ')}`)
        if (value.marks.length > 0) lines.push(`标注：${value.marks.join('；')}`)
        // 形势判断的那行数字：模型应直接引用它，别自己另算一个数
        if (value.territory !== undefined) lines.push(value.territory)
        if (value.territoryNote !== undefined) lines.push(`⚠ ${value.territoryNote}`)
        if (value.skipped.length > 0) lines.push(`⚠ 已忽略无法解析的项：${value.skipped.join('、')}`)
        lines.push('把下面这一行**原样**放进回答正文（Markdown 图片语法），图片就会显示：', value.markdown)
        if (value.note !== undefined) lines.push(value.note)
        return textBlock(lines)
      },
    },
    async execute(args, exec) {
      const base = typeof diagram?.base === 'string' ? diagram.base : ''
      if (base === '') {
        throw new Error(
          '当前进程没有挂载 Web 服务器（webServer），无法生成能在对话里显示的配图；'
          + '请改用文字说明，或确认 dsh web 面板已启用后重试。',
        )
      }
      const game = await readGameFile(ctx, exec, args.path, policy(exec))
      const size = game.info?.size ?? 19
      const total = game.moves.length
      const rawMove = args.moveNumber
      const parsed = rawMove === undefined || rawMove === null ? total : Math.trunc(Number(rawMove))
      const move = Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : total, total))

      // 变化图起始颜色：第 move 手之后的盘面轮到那一手的对手（move=0 时黑先）。
      // 与 /go-sensei/diagram 路由同一口径 —— 两边算错一处，图上颜色就会反。
      const firstColor = move === 0 ? 'B' : game.moves[move - 1]?.color === 'B' ? 'W' : 'B'
      const sequence = parseSequence(args.sequence, size, firstColor)
      const marks = parseMarks(args.marks, size)
      const caption = typeof args.caption === 'string' ? args.caption.trim().slice(0, 120) : ''

      const tokens = []
      for (const p of sequence.points) {
        tokens.push(`${p.color === 'B' ? 'B' : 'W'}:${coordLabelOf(p, size)}`)
      }
      const markTokens = []
      for (const m of marks.marks) {
        markTokens.push(`${m.shape}:${coordLabelOf(m, size)}${m.text !== undefined ? `:${m.text}` : ''}`)
      }

      const params = new URLSearchParams()
      // 用**实际读取的工作文件**（可能是 `-sensei` 副本）：分析数据与局面都在它里面，
      // 路由那边再套一次派生命名是幂等的。
      params.set('path', displayPathOf(game))
      params.set('move', String(move))
      if (tokens.length > 0) params.set('seq', tokens.join(','))
      if (markTokens.length > 0) params.set('marks', markTokens.join(','))
      if (caption !== '') params.set('cap', caption)
      // 形势判断：与面板**同一份引擎归属**（用户 2026-09-19 定案）——不再是启发式。
      // 副本里已有 TP[] 就直接读（毫秒级）；没有就当场补算一次：跑引擎 → 写回副本，
      // 与面板「形势判断」按钮同一条路径，算完以后这份棋谱永远秒开。
      // 引擎不可用 / 补算失败时**不画**，如实说明原因 —— 不用启发式顶包。
      const wantTerritory = args.territory === true
      let territoryText
      let territoryNote
      if (wantTerritory) {
        let hit = territoryOfMove(game, move)
        if (hit === null) {
          const { autoEngine } = await autoComputeIfNeeded(ctx, cfg, game, {
            needTerritory: true,
            signal: exec.signal,
          })
          if (autoEngine?.failed !== undefined) {
            territoryNote = `形势判断没能出图：${autoEngine.failed}`
          } else if (autoEngine !== undefined) {
            await writeAnalysisBack(ctx, exec, policy(exec), game).catch(() => undefined)
          }
          hit = territoryOfMove(game, move)
        }
        if (hit !== null) {
          params.set('territory', '1')
          territoryText = hit.text
        } else if (territoryNote === undefined) {
          territoryNote = '这一手还没有归属数据，形势判断没能出图。请在面板上点开一次「形势判断」补算，或先跑一次 go_review_moves。'
        }
      }
      if (args.width !== undefined && Number.isFinite(Number(args.width))) {
        params.set('w', String(Math.trunc(Number(args.width))))
      }
      const url = `${base}/go-sensei/diagram?${params.toString()}`
      const alt = (caption === '' ? `第 ${move} 手之后的局面` : caption).replace(/[[\]\n\r]/g, ' ').trim()
      const markdown = `![${alt}](${url})`

      const skipped = [...sequence.skipped, ...marks.skipped]
      const numbered = sequence.points.map((p, i) =>
        `${i + 1}. ${coordLabelOf(p, size)} ${p.color === 'B' ? '黑' : '白'}`)
      const markTexts = marks.marks.map((m) =>
        `${m.shape} ${coordLabelOf(m, size)}${m.text !== undefined ? `（${m.text}）` : ''}`)

      return {
        url,
        markdown,
        moveNumber: move,
        size,
        caption,
        numbered,
        marks: markTexts,
        skipped,
        ...(territoryText !== undefined ? { territory: territoryText } : {}),
        ...(territoryNote !== undefined ? { territoryNote } : {}),
        ...(total === 0 ? { note: '这盘棋没有着手，配图是空盘。' } : {}),
      }
    },
  }
}

/** 列标（跳过 I，与 sgf.js 的 coordLabel / client.js 的 boardLabel 同一套）。 */
const COORD_LETTERS = 'ABCDEFGHJKLMNOPQRST'

/** 盘面坐标 (x, y) -> 人类标签（如 (15,3) -> 'Q16'）：配图 URL 的 seq / marks 参数用的就是它。 */
function coordLabelOf(p, size) {
  return `${COORD_LETTERS.charAt(p.x)}${size - p.y}`
}

/**
 * 从每手的 C[] 注释里挑出**人写的讲解**，剔除引擎自动写入的分析行。
 *
 * 同一手节点的 C[] 通常同时含两类内容：引擎分析（"黑棋 胜率: …"、"领先: …"、
 * "(KataGo-18b / 250 计算量)"、"贴目: 0.0"）与复盘讲解（"这手应该出头。"）。
 * 报告只该收后者。判别方式是**整行匹配**已知分析形态，命中即丢弃其余保留——
 * 宁可多留一行（写"胜率"字样的讲解不会被误删），也不要把分析当讲解写进报告。
 *
 * @param {string} comment 该手 C[] 原文
 * @returns {string[]} 人写的讲解段落（按原顺序）
 */
export function extractUserNotes(comment) {
  if (typeof comment !== 'string' || comment.trim() === '') return []
  const ANALYSIS_LINE = [
    /^\s*[黑白]?[棋方]?\s*胜率\s*[:：]/, // 黑棋 胜率: 94.3% (-0.1%)
    /^\s*Winrate\s*[:：]/i,
    /^\s*领先\s*[:：]?/, // 领先: 6.7 (+0.1) 不确定度: 14.8
    /^\s*不确定度\s*[:：]/,
    /^\s*贴目\s*[:：]/, // 贴目: 0.0
    /^\s*Move\s+\d+\b/i, // Move 42 黑胜率: …
    /^\s*\(?[^()]{0,40}\s*\/\s*[\d.]+[kKmM]?\s*计算量\s*\)?\s*$/, // (KataGo-18b / 1.0k 计算量)
  ]
  const out = []
  for (const raw of comment.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (ANALYSIS_LINE.some((re) => re.test(line))) continue
    out.push(line)
  }
  return out
}

function buildReportSkeleton(game, cfg) {
  const info = game.info
  const level = inferLevel(info)
  const review = reviewGame(game, {
    winrateThreshold: cfg.winrateThreshold,
    scoreThreshold: cfg.scoreThreshold,
    pvDepth: cfg.pvDepth,
    maxPvCandidates: 3,
    maxCandidates: MAX_CANDIDATES_CAP,
  })
  const labelOf = (m) => (m.coord ? coordLabel(m.coord, info.size).label : '虚着')
  const lines = [
    `# 围棋复盘报告：${info.players.black ?? '黑'} vs ${info.players.white ?? '白'}`,
    '',
    `- 日期：${info.date ?? '未知'}；结果：${info.result ?? '未记录'}；规则：${info.rule ?? '未知'}（${info.size} 路，贴目 ${info.komi}，让子 ${info.handicap}）`,
    `- 讲解难度：${level}`,
    `- 数据模式：${review.mode === 'analysis' ? 'AI 分析' : '纯棋理（棋谱无分析数据）'}`,
    '',
    '## 问题手一览',
    '',
  ]
  if (review.candidates.length === 0) {
    lines.push('（未发现明显问题手）')
  } else {
    lines.push('| 手数 | 方 | 位置 | 标签 | 胜率损失 | 目差损失 | AI 候选 |', '|---|---|---|---|---|---|---|')
    for (const c of review.candidates) {
      lines.push(
        `| ${c.moveNumber} | ${c.color === 'B' ? '黑' : '白'} | ${c.coordLabel ?? ''} | ${c.label.label} | ${c.winrateLoss ?? '-'}% | ${c.scoreLoss ?? '-'} | ${c.pv?.map((p) => p.label).join('、') ?? '-'} |`,
      )
    }
  }

  // 汇总已写回的讲解：直接从棋谱 C[] 提取，使报告名副其实（工具描述承诺含"已写回注释"）。
  const noted = []
  for (const m of game.moves) {
    const notes = extractUserNotes(m.analysis?.comment)
    if (notes.length > 0) noted.push({ move: m, notes })
  }
  lines.push('', '## 逐手讲解', '')
  if (noted.length === 0) {
    lines.push('（棋谱中尚无复盘讲解；讲解后使用 go_write_review 写回，再导出即可汇总到此处）')
  } else {
    for (const { move, notes } of noted) {
      lines.push(`### 第 ${move.number} 手 ${move.color === 'B' ? '黑' : '白'} ${labelOf(move)}`, '')
      for (const n of notes) lines.push(n, '')
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 把「单次调用的引擎覆盖」合成成有效配置（go_engine_analyze 的临时换引擎口子）。
 *
 * 语义：
 *  - 只给 `kataGoPath` / `kataGoConfig` / `kataGoModel`：**逐项覆盖**，其余沿用配置；
 *  - 给了 `engineDir`：视为「改用这一整个引擎目录」——目录里的可执行文件、analysis 配置、
 *    权重优先，未同时显式指定的逐项路径**不再继承**。否则配置里的 `kataGoPath` 会压过
 *    本次传入的 `engineDir`，「临时换引擎」静默失效（实测踩过：传了 engineDir，回来的
 *    仍是"配置指定的引擎"）。
 *
 * @param {object} cfg 插件配置
 * @param {object} [args] 工具入参
 * @returns {object} 供 `resolveEngine` 使用的配置
 */
export function effectiveEngineConfig(cfg, args = {}) {
  const pick = (key) => {
    const value = args?.[key]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  const next = { ...cfg }
  const engineDir = pick('engineDir')
  if (engineDir === undefined) {
    for (const key of ['kataGoPath', 'kataGoConfig', 'kataGoModel']) {
      const value = pick(key)
      if (value !== undefined) next[key] = value
    }
    return next
  }
  next.engineDir = engineDir
  for (const key of ['kataGoPath', 'kataGoConfig', 'kataGoModel']) {
    const value = pick(key)
    next[key] = value !== undefined ? value : ''
  }
  return next
}

function goEngineAnalyze(ctx, cfg, cache, policy) {
  return {
    name: 'go_engine_analyze',
    description:
      '用本地 KataGo 引擎对指定手数区间补算分析（供无分析数据的棋谱）。默认使用插件自带的 engine 目录（开箱即用，无需配置）；也可用配置 engineDir / kataGoPath 指向自己的引擎，kataGoModel 指定权重。输出与 go_review_moves 同构的候选列表。补算出的逐手胜率/目差与 AI 首选/变化图会写回 WV[]/DM[]/LZ[] 属性（analysisWritten 字段报告写回了多少手与写到哪个文件）——**不覆盖源棋谱**：写入目标是同目录的 `<源名>-sensei.sgf` 副本，此后读这份副本（面板与工具都优先读它）就不必重算。对早先只有胜率/目差的棋谱再跑一次，即可补上首选与变化图。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SGF 文件路径（绝对路径，或相对当前会话工作区）' },
        from: { type: 'number', description: '补算起始手（默认 1）' },
        to: { type: 'number', description: '补算结束手（默认最后一手）' },
        maxVisits: { type: 'number', description: '每手搜索量（默认取配置 maxVisits，越大越准越慢）' },
        engineDir: { type: 'string', description: '临时覆盖引擎目录（内含 katago 可执行文件、analysis 配置、可选权重）' },
        kataGoPath: { type: 'string', description: '临时覆盖 KataGo 可执行文件路径' },
        kataGoConfig: { type: 'string', description: '临时覆盖 analysis 配置文件路径' },
        kataGoModel: { type: 'string', description: '临时覆盖模型权重文件路径（-model 参数）' },
        level: { type: 'string', description: `讲解难度覆盖：${RANKS.join('/')}/auto` },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          range: { type: 'object' },
          candidates: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
          // 写回棋谱的逐手分析：{ moves, missing } 或失败原因 { moves: 0, failed }
          analysisWritten: { type: 'object' },
        },
        required: ['path', 'range', 'candidates', 'note'],
      },
      render: (args, value) =>
        textBlock([
          `KataGo 补算完成：${value.path}（第 ${value.range.from}~${value.range.to} 手）。`,
          ...candidatesText(value.candidates, 'auto'),
          value.note,
        ]),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 300000,
    async execute(args, exec) {
      // 单次调用覆盖 = 「临时换引擎/换权重」的口子：覆盖项经 effectiveEngineConfig
      // 合成后走同一套 resolveEngine 解析，优先级规则只维护一处。
      const effective = effectiveEngineConfig(cfg, args)
      const engine = resolveEngine(effective)
      if (!engine.available) {
        throw new Error(engine.hint !== '' ? engine.hint : '没有可用的 KataGo 引擎')
      }
      const { runKataAnalyze } = await import('./engine.js')
      const game = await readGameFile(ctx, exec, args.path, policy(exec))
      if (game.info.size !== 19) throw new Error(`KataGo 补算目前仅支持 19 路（本局 ${game.info.size} 路）`)
      const from = Math.max(1, Math.trunc(args.from ?? 1))
      const to = Math.min(game.moves.length, Math.trunc(args.to ?? game.moves.length))
      if (from > to) throw new Error(`区间非法：from=${from} > to=${to}`)
      const maxVisits = Math.trunc(args.maxVisits ?? cfg.maxVisits ?? 100)
      if (maxVisits < 1 || maxVisits > 1000000) throw new Error('maxVisits 需在 1~1000000 之间')

      const subprocess = ctx.get('subprocess')
      if (!subprocess || typeof subprocess.spawn !== 'function') {
        throw new Error('subprocess 服务不可用，无法运行 KataGo 补算')
      }
      const spawn = (spec) => subprocess.spawn(spec)
      const result = await runKataAnalyze(spawn, {
        kataGoPath: engine.kataGoPath,
        configPath: engine.configPath,
        modelPath: engine.modelPath,
        game,
        from,
        to,
        maxVisits,
        signal: exec.signal,
      })
      const value = {
        path: displayPathOf(game),
        range: { from, to },
        candidates: result.candidates,
        note:
          `${describeEngine(engine)} 补算 ${result.moves} 手（${result.seconds}s），建议对关键手用 go_review_moves 复核。`
          + (engine.warning !== '' ? ` ⚠ ${engine.warning}` : ''),
      }
      // 写回的是**这次补算的结果**，所以必须先把引擎分析并回 game.moves。
      // 漏掉这一步时 writeAnalysisBack 读到的还是"读盘时的旧分析"：对一份全新棋谱
      // 等于什么都没写（entries 为空 → 直接返回），对一份只有 WV/DM 的旧棋谱则只是
      // 原样重写一遍 —— 2026-09-13 的 LZ 写回端到端验证正是这样暴露出来的。
      if (result.merge !== undefined) game.moves = result.merge.moves
      // 补算即写回：把逐手胜率/目差与 AI 首选/变化图写进棋谱（WV/DM/LZ），
      // 文件从此自带分析，面板与工具下次打开都不必重算。失败只记原因，不影响本次返回。
      const written = await writeAnalysisBack(ctx, exec, policy(exec), game)
        .then((r) => r ?? { moves: 0, missing: 0 })
        .catch((error) => ({ moves: 0, failed: String(error?.message ?? error) }))
      return {
        ...value,
        analysisWritten: written,
        note: value.note + (written.moves > 0
          ? ` 已把逐手胜率/目差与 AI 首选/变化图写回 ${written.path}（${written.moves} 手），下次打开无需重算；源棋谱保持原样。`
          : ''),
      }
    },
  }
}

/**
 * 引擎自述工具：让用户（与模型）随时看清"现在用的是哪个引擎、哪个权重"，
 * 以及换引擎/换权重的几种改法。始终注册——引擎不可用时它正是解释原因的地方。
 */
function goEngineInfo(ctx, cfg) {
  return {
    name: 'go_engine_info',
    description:
      '查看当前复盘实际使用的 KataGo 引擎与权重（是否可用、来源、路径、权重文件名与大小），以及换引擎/换权重/调搜索量的具体改法。用户问「现在用的是哪个模型」「怎么换模型」「为什么没补算」时调用。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean' },
          source: { type: 'string' },
          engineDir: { type: 'string' },
          kataGoPath: { type: 'string' },
          configPath: { type: 'string' },
          modelPath: { type: 'string' },
          modelName: { type: 'string' },
          modelSizeMB: { type: 'number' },
          modelSource: { type: 'string' },
          platform: { type: 'string' },
          warning: { type: 'string' },
          note: { type: 'string' },
          howTo: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'available', 'source', 'engineDir', 'kataGoPath', 'configPath', 'modelPath',
          'modelName', 'modelSizeMB', 'modelSource', 'platform', 'warning', 'note', 'howTo',
        ],
      },
      render: (args, value) => textBlock([
        value.available ? `✅ ${value.note}` : `⚠ ${value.note}`,
        value.available ? `引擎：${value.kataGoPath}` : '',
        value.modelPath !== '' ? `权重：${value.modelPath}` : '',
        value.warning !== '' ? `⚠ ${value.warning}` : '',
        '换法：',
        ...value.howTo.map((line) => `- ${line}`),
      ].filter((line) => line !== '')),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 10000,
    async execute() {
      const engine = resolveEngine(cfg)
      return {
        available: engine.available,
        source: engine.source,
        engineDir: engine.engineDir,
        kataGoPath: engine.kataGoPath,
        configPath: engine.configPath,
        modelPath: engine.modelPath,
        modelName: engine.modelName,
        modelSizeMB: engine.modelSizeMB,
        modelSource: engine.modelSource,
        platform: engine.platform,
        warning: engine.warning,
        note: engine.available ? `当前可用：${describeEngine(engine)}` : engine.hint,
        howTo: [
          '把任意 *.bin.gz 权重丢进引擎目录，插件自动挑其中最大的一个（b28 比 b18 大，也更强）',
          '想指定具体权重：配置 kataGoModel 填 .bin.gz 的完整路径',
          '想换引擎或换后端（CUDA / CPU 版等）：配置 engineDir 指向你自己的引擎目录（内含 katago 可执行文件、analysis_example.cfg、权重）',
          '只想临时换一次：go_engine_analyze 支持 engineDir / kataGoPath / kataGoConfig / kataGoModel 参数覆盖',
          '想调搜索量：配置 maxVisits（默认 100，越大越准越慢）',
          '改完配置需要重启 dsh web 才会重新注册补算工具',
        ],
      }
    },
  }
}

/**
 * 注册全部围棋复盘工具。
 * @param {object} ctx Cordis 上下文（须已注入 tools/systemPrompt/fs）
 * @param {object} cfg 已校验的插件配置
 * @param {ReviewCache} [cache]
 */
export function registerGoTools(ctx, cfg, cache = new ReviewCache(), opts = {}) {
  // 每次执行解析一次沙箱策略：既用于路径解析基准，也随写入携带给沙箱后端。
  const policy = compileSandboxPolicy(ctx)
  const engine = resolveEngine(cfg)
  // 配图基地址（webServer 挂载时填充）：go_draw_diagram 执行时读取，缺失时如实报错。
  const diagram = opts.diagram
  // go_engine_info 始终注册：引擎不可用时它正是解释"为什么没有补算/怎么配"的地方。
  const tools = [goParseSgf, goReviewMoves, goPositionContext, goDrawDiagram, goWriteReview, goExportReport, goEngineInfo]
  // 引擎可用（配置指定，或随包自带的 engine/ 目录）才注册补算工具，与提示语一致。
  if (engine.available) tools.push(goEngineAnalyze)
  for (const factory of tools) {
    const def = factory(ctx, cfg, cache, policy, diagram)
    // 顶层统一收紧 lossless JSON：所有返回值（含 go_parse_sgf 的 info 等
    // 可能含 undefined 的字段）过一遍 compact，防止运行时整体拒收。
    const execute = def.execute
    def.execute = async (args, exec) => compact(await execute(args, exec))
    ctx.tools.register(def)
  }
  return cache
}

export { buildReportSkeleton }

/**
 * 无分析数据且引擎可用时，自动自起 KataGo 补算并把结果合成进 `game`。
 *
 * **为什么要抽成独立函数**：面板数据路由（`index.mjs` 的 `registerPanelRoute`）
 * 与 `go_review_moves` 都必须走这一步。早期把它内联在 `go_review_moves.execute`
 * 里，而面板路由自己调 `reviewGame` —— 于是同一份无分析棋谱，在对话里复盘能出
 * 问题手，面板却显示「未发现问题手」：两套 review 管线漂移。同一业务逻辑只保留
 * 一份，是这次修复的核心。
 *
 * 语义：
 *  - 仅在**引擎可用**（配置指定，或随包自带的 `engine/` 目录解析成功）、
 *    棋谱**完全无分析数据**、且 19 路时触发；
 *  - 成功时**原地**替换 `game.moves`（换成含补算分析的副本）；
 *  - 失败**不抛错、不阻断**，返回 `{ autoEngine: { failed } }` 让调用方如实上报。
 *
 * @param {object} ctx Cordis 上下文（需可 `ctx.get('subprocess')`）
 * @param {object} cfg 已校验的插件配置
 * @param {object} game `parseGame` 返回值；成功时其 `moves` 被原地替换
 * @param {{ from?: number, to?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ autoEngine: object | undefined }>}
 *   `autoEngine` = `{from,to,moves,seconds,engine,model}`（成功）或 `{failed}`（失败）；未触发时为 undefined
 */
export async function autoComputeIfNeeded(ctx, cfg, game, opts = {}) {
  const engine = resolveEngine(cfg)
  // 判据是「有没有可用的逐手胜率」，不是「有没有 analysis 对象」：只写了一般注释
  // 的棋谱也会产出 analysis，若按后者判定就会既跳过补算、又算不出问题手。
  const noAnalysisData = !hasWinrateData(game)
  // 「形势判断」要逐手归属图：老副本有 WV/DM/LZ、却没有 TP[]，同样得再跑一次引擎
  // （用户 2026-09-19 明确要求）。判据用 hasTerritoryData —— 能力判据，不是结构判据。
  const needTerritory = opts.needTerritory === true && !hasTerritoryData(game)
  if (!engine.available || (!noAnalysisData && !needTerritory) || game.info.size !== 19) {
    return { autoEngine: undefined }
  }
  // 同一份棋谱只补算一次：模型刚算完、面板再打开同一盘棋（或反复开关棋盘）时
  // 直接复用内存结果，不再让用户等第二次几十秒的引擎时间。指纹覆盖手顺与规则参数，
  // 注释变化（写回讲解）不影响命中 —— 那正是最常发生的"同一盘棋再看一遍"。
  const memoKey = `${gameFingerprint(game)}|${cfg.maxVisits}`
  const memo = ANALYSIS_CACHE.get(memoKey)
  if (memo !== undefined) {
    const merged = mergeCachedAnalysis(game, memo.byMove)
    if (merged > 0) {
      return {
        autoEngine: {
          from: memo.from,
          to: memo.to,
          moves: memo.moveCount,
          seconds: memo.seconds,
          engine: memo.engine,
          model: memo.model,
          source: memo.source,
          cached: true,
        },
      }
    }
  }
  const totalMoves = game.moves.length
  const from = Math.max(1, Math.trunc(opts.from ?? 1))
  const to = Math.min(totalMoves, Math.trunc(opts.to ?? totalMoves))
  try {
    const { runKataAnalyze } = await import('./engine.js')
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      return { autoEngine: { failed: 'subprocess 服务不可用，无法自起 KataGo 补算' } }
    }
    const result = await runKataAnalyze((spec) => subprocess.spawn(spec), {
      kataGoPath: engine.kataGoPath,
      configPath: engine.configPath,
      modelPath: engine.modelPath,
      game,
      from,
      to,
      maxVisits: cfg.maxVisits,
      signal: opts.signal,
    })
    if (result.merge === undefined) return { autoEngine: undefined }
    game.moves = result.merge.moves
    const autoEngine = {
      from,
      to,
      moves: result.moves,
      seconds: result.seconds,
      engine: result.engine ?? 'KataGo',
      model: engine.modelName,
      source: engine.source,
    }
    // 记进缓存：同一盘棋的后续读取（面板/工具）直接复用，不再重跑引擎
    ANALYSIS_CACHE.set(memoKey, {
      // 只存**分析字段**，不存整份 moves：缓存是"上一版文件"的快照，
      // 而指纹不覆盖 C[] 注释 —— 直接用缓存覆盖 moves 会把刚写回的讲解抹掉
      // （真机踩过：注释写回后，面板的 comments 恒为空）。
      byMove: game.moves
        .map((m) => ({
          number: m.number,
          analysis: m.analysis,
          // 归属图也一并缓存：命中缓存时不必为了「形势判断」再跑一次引擎
          ...(m.ownership !== undefined ? { ownership: m.ownership } : {}),
        }))
        .filter((entry) => entry.analysis !== undefined),
      from,
      to,
      moveCount: result.moves,
      seconds: result.seconds,
      engine: autoEngine.engine,
      model: engine.modelName,
      source: engine.source,
    })
    while (ANALYSIS_CACHE.size > ANALYSIS_CACHE_MAX) {
      const oldest = ANALYSIS_CACHE.keys().next().value
      ANALYSIS_CACHE.delete(oldest)
    }
    return { autoEngine }
  } catch (error) {
    // 补算失败不能阻断复盘：降级为 theory 模式，并把原因如实带出
    return { autoEngine: { failed: String(error?.message ?? error) } }
  }
}

/**
 * 把补算出来的逐手分析写回棋谱文件（KataGo 属性 `WV`/`DM`，以及候选着法 `LZ`）。
 *
 * `LZ` 是**AI 首选与变化图**的载体：它们只存在候选着法里，只写 `WV`/`DM` 的话文件下次
 * 被打开时会被判为"已有分析"→ 不再补算，而候选取不到 → 面板上只剩问题手、没有首选点和
 * 变化图（2026-09-13 用户实报）。写入格式见 sgf.js 的 serializeLz。
 *
 * 解决的真机问题：讲解已写回 `C[]` 注释、但文件里没有任何胜率数据，于是每次
 * 重新打开同一份棋谱都要再补算一次（实测 30~100 秒），别的打谱软件看到的也
 * 只是一盘没有分析的棋。写回后文件自带分析，谁再读都不必重算。
 *
 * 只在**本次真的跑了引擎**之后调用（缓存命中或本来就有分析的棋谱都不写）：
 * 读盘 → 改属性 → 写盘必须发生在明确的分析动作里，不能由只读路径顺手做掉。
 *
 * **写到哪**：源棋谱同目录的 `<源名>-sensei.sgf`（见 src/derived.js），源文件不动。
 *
 * @param {object} ctx Cordis 上下文（需 fs）
 * @param {object} exec 工具执行上下文（写盘要带 exec.signal）
 * @param {object} sandboxPolicy 本会话的沙箱策略（写盘必须携带，见文件顶部说明）
 * @param {object} game readGameFile 的返回值（含 _meta.text 原文与 _meta.sourcePath）
 * @returns {Promise<{moves: number, missing: number, path: string} | undefined>} 没有可写内容时 undefined
 */
export async function writeAnalysisBack(ctx, exec, sandboxPolicy, game) {
  const text = game?._meta?.text
  if (typeof text !== 'string' || text === '') return undefined
  // 形势判断：有引擎归属图的手，就地算出三档图挂到 move 上 —— analysisEntriesOf 会
  // 把它带进 entries，injectAnalysis 写成 TP[]。没有归属图的手（老副本、老棋谱）不动。
  attachTerritory(game)
  const entries = analysisEntriesOf(game)
  if (entries.length === 0) return undefined
  // 真有内容要写时才要求策略：无策略即拒绝（调用方 go_review_moves 会吞掉这个错误
  // 并跳过写回，绝不静默地做一次不受约束的写）。
  requireSandboxPolicy(sandboxPolicy)
  const injected = injectAnalysis(text, entries)
  if (injected.written.length === 0) return undefined
  // 写回**副本**：源棋谱（野狐导出/别人给的谱）永远保持原样，分析数据与讲解
  // 都只落在同目录的 `-sensei.sgf` 里。副本已存在时读的就是它（resolveWorkingFile），
  // 所以这里的注入是在"上一版副本"基础上增量进行，不会抹掉先前写回的讲解。
  const target = await derivedTargetFor(ctx, exec, game._meta.sourcePath ?? game._meta.path, sandboxPolicy)
  await ctx.fs.writeText(target, injected.text, undefined, exec?.signal, sandboxPolicy)
  game._meta.text = injected.text
  game._meta.path = target.displayPath
  game._meta.derived = target.displayPath !== game._meta.sourcePath
  ctx.emit('fs/observed', target, { kind: 'present' }, exec)
  return { moves: injected.written.length, missing: injected.missing.length, path: target.displayPath }
}

/**
 * 把引擎补算产出的逐手归属图算成三档图，挂到 `move.territory`（紧凑字符串）。
 *
 * 只有**这一条路**会把 TP[] 写进棋谱副本：从副本读回来时 `move.territory` 已存在，
 * 而归属图（`move.ownership`）不会从文件里读回来 —— 所以日常读盘不会重算、也不会覆盖。
 *
 * @param {object} game readGameFile / 补算后的棋局
 * @returns {number} 实际挂上的手数
 */
export function attachTerritory(game) {
  const moves = game?.moves ?? []
  const ownerships = moves.map((m) => (m?.ownership && m.ownership.length > 0 ? m.ownership : null))
  if (!ownerships.some((o) => o !== null)) return 0
  const series = estimateTerritorySeries(compactBoard(game), ownerships)
  let count = 0
  for (let i = 0; i < moves.length; i++) {
    const item = series[i]
    if (!item) continue
    moves[i].territory = item.packed
    count++
  }
  return count
}

/** 补算结果缓存的上限（条目数；每条是一份棋谱的逐手分析）。 */
const ANALYSIS_CACHE_MAX = 8
/** 补算结果缓存：key = 棋谱指纹 + 搜索量，value = 该次补算的逐手分析。 */
const ANALYSIS_CACHE = new Map()

/**
 * 把缓存里的逐手分析并回**刚解析出来的** moves 上。
 *
 * 为什么不直接用缓存的 moves 覆盖：解析结果里还带着 `C[]` 注释等只属于"这一版
 * 文件"的字段，而缓存键（棋谱指纹）只覆盖手顺与规则参数 —— 讲解写回后指纹不变，
 * 整份覆盖会把新写的注释抹掉（真机症状：讲解已写回，面板 comments 恒为空）。
 * 合并只替换 `analysis`，且保留新旧都有的自有字段（如 comment）。
 *
 * @param {object} game parseGame 的返回值（原地修改其 moves）
 * @param {Array<{number: number, analysis: object}>} byMove 缓存下来的逐手分析
 * @returns {number} 实际并回分析的手数（0 表示缓存与这份棋谱对不上，应按未命中处理）
 */
export function mergeCachedAnalysis(game, byMove) {
  if (!Array.isArray(byMove) || byMove.length === 0) return 0
  const table = new Map()
  for (const entry of byMove) {
    if (entry !== undefined && entry !== null && entry.analysis !== undefined) {
      table.set(entry.number, entry)
    }
  }
  let merged = 0
  for (const move of game?.moves ?? []) {
    const entry = table.get(move.number)
    if (entry === undefined) continue
    // 先摊开新解析出的自有字段（comment 等），再盖上缓存的分析字段
    const own = move.analysis === undefined || move.analysis === null ? {} : move.analysis
    move.analysis = { ...own, ...entry.analysis }
    // 归属图也在缓存里（形势判断要用），一并并回
    if (entry.ownership !== undefined) move.ownership = entry.ownership
    merged += 1
  }
  return merged
}
