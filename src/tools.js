// src/tools.js — 围棋复盘工具集（DeepGo Sensei）
//
// 以裸 JSON-Schema ToolDefinition 直接注册（官方 cookbook 认可的路径，
// 零 @deepseek-ai 值导入）。全部文件 I/O 走 ctx.fs 服务，遵守会话文件策略；
// 相对路径按调用会话工作区解析（exec.agent.session.header.cwd，与官方
// read/write 工具同一机制）。工具注册是 effect：随插件 fiber 自动反注册。

import { decodeBuffer, parseGame, injectComments, coordLabel } from './sgf.js'
import { reviewGame, inferLevel, RANKS } from './review.js'
import { ReviewCache } from './cache.js'
import { resolveEngine, describeEngine } from './engine-resolve.js'

/** 工具返回值的裁剪上限，防止异常棋谱撑爆上下文。 */
const MAX_MOVE_LIST = 400
const MAX_CANDIDATES_CAP = 50
const MAX_ENTRIES_PER_WRITE = 200
const MAX_COMMENT_CHARS = 2000

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
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) {
    ctx.logger?.warn?.(
      'go-sensei：未找到 sandboxPolicy 服务；写入类工具在沙箱后端下可能被拒（file access denied）',
    )
    return () => undefined
  }
  return (exec) => {
    const session = exec?.agent?.session
    return service.resolve(session !== undefined ? { session } : {})
  }
}

function resolveOptions(exec, p, policy) {
  // 有策略时以它的 workspaceRoot 为基准（官方语义）；否则退回会话 cwd。
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
  return { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal }
}

async function resolveRegularFile(ctx, exec, p, policy) {
  const target = await ctx.fs.resolve(p, resolveOptions(exec, p, policy))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`找不到文件：${p}`)
  if (info.type !== 'file') throw new Error(`不是普通文件：${p}`)
  return target
}

async function readGameFile(ctx, exec, p, policy) {
  const target = await resolveRegularFile(ctx, exec, p, policy)
  const bytes = await ctx.fs.readBytes(target, exec.signal, 64 * 1024 * 1024)
  const { text, encoding } = decodeBuffer(bytes)
  const game = parseGame(text)
  game._meta = { path: target.displayPath, encoding }
  return game
}

function displayPathOf(game) {
  return game._meta?.path ?? '?'
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
 * 递归剔除值为 undefined 的对象属性与数组项。
 *
 * 工具返回值必须整体是 lossless JSON：属性值为 undefined 的对象被运行时
 * （dsh-util-values 的 walkJsonValue）判为非法，整次调用会以
 * "value is not lossless JSON" 失败 —— JSON.stringify 会静默丢键，故本地不易发现。
 * 可选字段一律走这里清洗，而不是写成 `key: maybeUndefined`。
 * @template T
 * @param {T} value
 * @returns {T} 清洗后的副本（非对象值原样返回）
 */
function compact(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map((v) => compact(v))
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = compact(v)
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
      '解析 SGF 围棋棋谱：返回棋局元信息（黑白棋手/段位/贴目/让子/结果/规则）与主变化线每手序列（坐标、颜色、虚着）。支持野狐/弈城导出的 GBK 编码，以及 KataGo 分析属性（WV/DM/PV）与注释内胜率行等带分析的棋谱。',
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
        hasAnalysis: game.moves.some((m) => m.analysis !== null),
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
      '识别 SGF 棋谱中的问题手（胜率/目差落差超阈值的候选），返回按严重度排序的裁剪后列表（每手 ≤3 个 AI 候选点、PV 截断、数值 1 位小数、标签枚举：大恶手/失误/不精确）。无分析数据的棋谱返回 theory 模式（纯棋理复盘）。同一局面重复复盘命中缓存。',
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

      const { review, level } = reviewToolValue(game, cfg, args)
      const value = {
        path: displayPathOf(game),
        // 仅在有补算结果/失败原因时写入该键；否则交由 compact 剔除。
        ...(autoEngine !== undefined ? { autoEngine } : {}),
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
      '把讲解写回 SGF 棋谱的 C[] 注释（任何能显示注释的打谱软件/App 都能看到）。entries 为 [{ moveNumber, comment }]，每局最多 200 条、单条 ≤2000 字；已有注释默认换行追加（replace=true 覆盖）。写入后请用 go_parse_sgf 复核。',
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
      const sandboxPolicy = policy(exec)
      const target = await resolveRegularFile(ctx, exec, args.path, sandboxPolicy)
      const bytes = await ctx.fs.readBytes(target, exec.signal, 64 * 1024 * 1024)
      const { text } = decodeBuffer(bytes)
      const result = injectComments(text, cleaned, { replace: args.replace === true })
      if (result.written.length === 0) {
        throw new Error(`没有写入任何注释：指定手数均不存在（${result.missing.join(', ') || '未知原因'}）`)
      }
      // 第 5 参数必须带沙箱策略，否则沙箱后端按自身默认策略拒写。
      await ctx.fs.writeText(target, result.text, undefined, exec.signal, sandboxPolicy)
      ctx.emit('fs/observed', target, { kind: 'present' }, exec)
      return {
        path: target.displayPath,
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
      '把复盘报告落盘为 Markdown（默认与棋谱同目录、同名 .review.md）。content 为报告全文；省略时自动生成骨架报告（棋局信息 + 问题手表格 + 已写回注释）。',
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
      const sandboxPolicy = policy(exec)
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
 * 从每手的 C[] 注释里挑出**人写的讲解**，剔除 Lizzieyzy/KataGo 自动写入的分析行。
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

function goEngineAnalyze(ctx, cfg, cache, policy) {
  return {
    name: 'go_engine_analyze',
    description:
      '用本地 KataGo 引擎对指定手数区间补算分析（供无分析数据的棋谱）。默认使用插件自带的 engine 目录（开箱即用，无需配置）；也可用配置 engineDir / kataGoPath 指向自己的引擎，kataGoModel 指定权重。输出与 go_review_moves 同构的候选列表。',
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
      // 单次调用覆盖 = 「临时换引擎/换权重」的口子：覆盖项合并进 cfg 后走同一套解析，
      // 因此只需维护 resolveEngine 一处优先级规则。
      const effective = {
        ...cfg,
        ...(typeof args.engineDir === 'string' ? { engineDir: args.engineDir } : {}),
        ...(typeof args.kataGoPath === 'string' ? { kataGoPath: args.kataGoPath } : {}),
        ...(typeof args.kataGoConfig === 'string' ? { kataGoConfig: args.kataGoConfig } : {}),
        ...(typeof args.kataGoModel === 'string' ? { kataGoModel: args.kataGoModel } : {}),
      }
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
      return value
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
export function registerGoTools(ctx, cfg, cache = new ReviewCache()) {
  // 每次执行解析一次沙箱策略：既用于路径解析基准，也随写入携带给沙箱后端。
  const policy = compileSandboxPolicy(ctx)
  const engine = resolveEngine(cfg)
  // go_engine_info 始终注册：引擎不可用时它正是解释"为什么没有补算/怎么配"的地方。
  const tools = [goParseSgf, goReviewMoves, goPositionContext, goWriteReview, goExportReport, goEngineInfo]
  // 引擎可用（配置指定，或随包自带的 engine/ 目录）才注册补算工具，与提示语一致。
  if (engine.available) tools.push(goEngineAnalyze)
  for (const factory of tools) {
    const def = factory(ctx, cfg, cache, policy)
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
  const noAnalysisData = !game.moves.some((m) => m.analysis !== null)
  if (!engine.available || !noAnalysisData || game.info.size !== 19) {
    return { autoEngine: undefined }
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
    return {
      autoEngine: {
        from,
        to,
        moves: result.moves,
        seconds: result.seconds,
        engine: result.engine ?? 'KataGo',
        model: engine.modelName,
        source: engine.source,
      },
    }
  } catch (error) {
    // 补算失败不能阻断复盘：降级为 theory 模式，并把原因如实带出
    return { autoEngine: { failed: String(error?.message ?? error) } }
  }
}
