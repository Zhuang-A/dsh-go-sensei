// index.mjs — DeepGo Sensei 宿主（Node）half
//
// 官方函数插件协议：具名导出 name/inject/Config/apply，无 default export
// （混用两种导出形态会被 Loader 丢弃命名空间，见官方 postmortem 0001）。
// 注册是 effect：工具与提示词段随插件 fiber 自动装卸。

import Schema from '@deepseek-ai/schemastery'
import { basename } from 'node:path'
import { registerGoTools, autoComputeIfNeeded } from './src/tools.js'
import { ReviewCache } from './src/cache.js'
import { RANKS, reviewGame, inferLevel, aiCandidatesByMove } from './src/review.js'
import { parseGame, decodeBuffer, coordLabel } from './src/sgf.js'
import { senseiPathFor } from './src/derived.js'

export const name = 'go-sensei'
// 硬依赖：tools 注册工具、systemPrompt 挂人设段、fs 读写棋谱。
// 可选依赖（不得写进 inject，否则未挂载时整插件等待）：
//   sandboxPolicy —— 沙箱后端下写入必须携带它解析出的策略，见 src/tools.js。
//   webServer     —— 客户端面板的数据路由，见 registerPanelRoute。
export const inject = ['tools', 'systemPrompt', 'fs']

/** 插件配置（加载期由 Cordis 按 Schema 校验并填充默认值）。 */
export const Config = Schema.object({
  /** 讲解难度：18K..9D，或 auto（按棋谱双方段位自适应）。 */
  level: Schema.union([...RANKS, 'auto']).default('auto'),
  /** 问题手胜率落差阈值（0~1 小数）。 */
  winrateThreshold: Schema.number().default(0.03),
  /** 问题手目差阈值（目）。 */
  scoreThreshold: Schema.number().default(3),
  /** 每次复盘返回的候选上限。 */
  maxCandidates: Schema.number().default(10),
  /** 每条候选变化图的 PV 截断手数。 */
  pvDepth: Schema.number().default(6),
  /** 单局讲解 token 预算（提示词与裁剪策略的软约束）。 */
  tokenBudget: Schema.number().default(50000),
  /** 引擎目录（含 katago 可执行文件、analysis 配置、*.bin.gz 权重）；留空＝用插件自带的 engine/ 目录。 */
  engineDir: Schema.string().default(''),
  /** KataGo 引擎可执行文件路径（为空则用 engineDir 里找到的，或插件自带的）。 */
  kataGoPath: Schema.string().default(''),
  /** KataGo 配置文件路径（可选）。 */
  kataGoConfig: Schema.string().default(''),
  /** KataGo 模型权重路径（可选，覆盖配置文件中的 modelFile）。 */
  kataGoModel: Schema.string().default(''),
  /** KataGo 补算每手搜索量。 */
  maxVisits: Schema.number().default(100),
})

const DEFAULT_CONFIG = {
  level: 'auto',
  winrateThreshold: 0.03,
  scoreThreshold: 3,
  maxCandidates: 10,
  pvDepth: 6,
  tokenBudget: 50000,
  engineDir: '',
  kataGoPath: '',
  kataGoConfig: '',
  kataGoModel: '',
  maxVisits: 100,
}

/**
 * 围棋老师人设段。放在 persona-prefix 之后（约第 1 位），
 * 以条件式开头："当用户请求围棋复盘时"才生效，不影响其他会话主题。
 */
function buildPersona(cfg) {
  return `当用户请求围棋复盘、分析 SGF 棋谱、或询问某一手棋的好坏时，你以温和耐心的围棋老师（DeepGo Sensei）身份讲解：

1. 教学姿态：先复述这手棋的意图，或先问学生想听哪方面（"这手为什么不好"还是"该怎么下"），再指出问题，最后给出具体改进建议；多鼓励、少批评、不嘲讽。
2. 讲解语言：用口语化的棋理讲解（如"这里就像把家门让给了对方"）；胜率与目差只是佐证——先讲棋理，再引用数值；绝不虚构分析数据或变化图。
3. 水平自适应：按学生棋力调整术语密度（配置 level=auto 时依据棋谱双方段位自行判断）：18K~10K 用生活化比喻并解释基础概念（气、眼、断点、出头）；9K~1D 用常规术语；2D 以上可用职业级术语与全局构思。
4. 变化图：以"第 N 手改下 X 会怎样"为单元，一次只展开一条主变，每手一句话讲清意图，不逐手复述整条 PV。
5. 工具纪律：先 go_parse_sgf 了解棋谱，再 go_review_moves 找问题手，逐手讲解后调用 go_write_review 写回 SGF 注释，需要落盘报告时用 go_export_report；同一局重复复盘优先复用工具返回的缓存结果（cached=true 时不再重复获取全量数据）；单局讲解预算约 ${cfg.tokenBudget} tokens，用"先问后讲"与数据裁剪控制消耗。`
}

const TOOL_GUIDANCE = `围棋复盘工具（DeepGo Sensei）：go_parse_sgf 读棋谱，go_review_moves 找问题手，go_position_context 取某手前后局面与 AI 候选，go_write_review 把讲解写回 SGF 的 C[] 注释，go_export_report 落盘 Markdown 报告，go_engine_info 查看/说明当前使用的 KataGo 引擎与权重。**源棋谱只读**：讲解与分析数据（胜率/目差/AI 首选与变化图）都写进同目录的 \`<源名>-sensei.sgf\` 副本，源文件永不修改；读取同一盘棋时若副本已存在（工具与面板都一样）就直接读副本，因为那才是上一次复盘的成果。补算引擎默认用插件自带的 engine 目录（开箱即用），也可用配置 engineDir / kataGoPath / kataGoModel 换成用户自己的引擎与权重。路径参数支持绝对路径或相对当前会话工作区的相对路径。`

/** 面板一次最多返回的问题手数（数据裁剪 + 渲染上限一起生效）。 */
const MAX_PANEL_CANDIDATES = 20

/** 面板一次最多带多少手的逐手 AI 候选（正常一局 ≤ 400 手，防御性上限）。 */
const MAX_PANEL_AI_MOVES = 400

/**
 * 逐手「AI 首选与变化图」：手数 -> 候选点（≤3 个，只留标签、胜率与变化线）。
 *
 * 为什么要单独带一份：`candidates` 只含**超阈值的问题手**，而讲解点未必是问题手
 * ——老师也会在好手、关键处写讲解。只靠 candidates 的话，翻到那些手时盘上就没有
 * 首选点与变化图（2026-09-13 用户实报：「对于讲解点也需要标注 AI 首选和变化图」）。
 *
 * 口径与列表里的候选同源（都取上一手节点，见 src/review.js 的 aiCandidatesByMove），
 * 所以同一手在列表里与盘上给出的首选点永远一致。
 *
 * @param {object} game parseGame 的返回值
 * @param {object} cfg 已校验的插件配置
 * @returns {Record<string, Array<{label: string, winratePct: number|null, line: string}>>}
 */
function compactAi(game, cfg) {
  const byMove = aiCandidatesByMove(game, {
    pvDepth: cfg.pvDepth,
    maxCandidates: 3,
    limit: MAX_PANEL_AI_MOVES,
  })
  const out = {}
  for (const [key, list] of Object.entries(byMove)) {
    out[key] = list.map((p) => ({
      label: p.label ?? '',
      winratePct: p.winratePct ?? null,
      // 变化线（首选之后的后续几手）：'F16 N17 Q5 R14' —— **第一个是该候选自己**，
      // 面板从第二个开始画。缺了它盘上就只剩一个光秃秃的首选点。
      line: typeof p.pv === 'string' ? p.pv : '',
    }))
  }
  return out
}

/** 裁剪为面板需要的最小字段，避免把整个 review 对象推给浏览器。 */
function compactForPanel(candidate) {
  return {
    moveNumber: candidate.moveNumber,
    color: candidate.color,
    coord: candidate.coord ?? '',
    coordLabel: candidate.coordLabel ?? '',
    label: candidate.label?.label ?? '',
    // 等级 key 供棋盘按严重度取色（大恶手/失误/不精确 → 紫/红/橙，与 Lizzieyzy 同色系）
    labelKey: candidate.label?.key ?? '',
    winrateLoss: candidate.winrateLoss ?? null,
    scoreLoss: candidate.scoreLoss ?? null,
    pv: (candidate.pv ?? []).slice(0, 3).map((p) => ({
      label: p.label ?? '',
      winratePct: p.winratePct ?? null,
      // 该候选的变化线（'F16 N17 Q5 R14'，第一个是该候选自己）：盘上要画的是
      // **首选之后的后续几手**，不是"第 2、3 个候选点"（用户 2026-09-13 明确）。
      line: typeof p.pv === 'string' ? p.pv : '',
    })),
  }
}

/** 面板默认基准目录：无 cwd 参数时的回退（浏览器会带上当前会话工作区）。 */
function panelDefaultRoot() {
  return process.cwd()
}

/**
 * 按会话 id 反查工作区根。
 *
 * 为什么必须放在宿主：右侧栏的文档标签页给的是**会话内相对路径**（地址形如
 * `dsh-resource://file/session/<会话>/<相对路径>`），而浏览器侧拿不到会话 cwd
 * （客户端快照里没有这个字段，实测）。插件自记的 roots 又只在模型调用过 go_*
 * 之后才存在 —— 重启后第一次从文件列表打开棋谱，正好落在那个空窗里。
 * 宿主有 sessions 服务，可以直接拿 id 问出工作区根。
 *
 * sessions 是可选依赖：缺席或查不到返回空串，路径解析退回既有候选顺序。
 *
 * @param {object} ctx Cordis 上下文
 * @param {string|null} sessionId 会话 id（来自文档地址）
 * @returns {string} 工作区根；无法确定时为空串
 */
function sessionRootOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  try {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return ''
    const session = sessions.get(sessionId)
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  } catch {
    return ''
  }
}

/**
 * 棋盘数据：把主变化线与摆子压成坐标整数，浏览器直接画，不必自己解析 SGF。
 *
 * 为什么与问题手同一路由返回：客户端拿不到 game（它既不能读盘也不能调工具），
 * 单独开一条棋盘路由等于同一份棋谱再读一次、再解析一次；而棋盘与问题手永远
 * 是同一局，同一次请求里一起给出既省事又不会二者不同步。
 *
 * @param {object} game parseGame 的返回值
 * @returns {{ size: number, komi: number, handicap: number,
 *             moves: Array<{c: string, x: number, y: number}>,
 *             setup: { black: number[][], white: number[][] } }}
 */
function compactBoard(game) {
  const size = game.info?.size ?? 19
  /** 坐标 -> [x, y]；虚着/越界返回 null。 */
  const point = (coord) => {
    const at = coordLabel(coord ?? '', size)
    if (at.pass || at.x < 0 || at.y < 0 || at.x >= size || at.y >= size) return null
    return [at.x, at.y]
  }
  return {
    size,
    komi: game.info?.komi ?? 0,
    handicap: game.info?.handicap ?? 0,
    // 虚着用 x=y=-1 表示（棋盘不落子，但手顺要保留，否则手数对不上）
    moves: (game.moves ?? []).map((m) => {
      const p = m.pass ? null : point(m.coord)
      return p === null ? { c: m.color, x: -1, y: -1 } : { c: m.color, x: p[0], y: p[1] }
    }),
    setup: {
      black: (game.setup?.black ?? []).map(point).filter((p) => p !== null),
      white: (game.setup?.white ?? []).map(point).filter((p) => p !== null),
    },
  }
}

/**
 * 讲解注释（C[]）：按手数交给浏览器，让棋盘能显示"这一手当时是怎么讲的"。
 *
 * 截断与条数上限一起生效：一份整盘讲解有几十条、每条上千字，全量推给浏览器
 * 既没必要（一次只看一手）也拖慢面板。
 *
 * @param {object} game parseGame 的返回值
 * @returns {Record<string, string>} 手数 -> 注释文本
 */
function compactComments(game) {
  const out = {}
  let count = 0
  for (const move of game.moves ?? []) {
    const text = move.analysis?.comment
    if (typeof text !== 'string' || text.trim() === '') continue
    if (count >= MAX_PANEL_COMMENTS) break
    const trimmed = text.trim()
    out[String(move.number)] = trimmed.length > MAX_PANEL_COMMENT_CHARS
      ? `${trimmed.slice(0, MAX_PANEL_COMMENT_CHARS)}…`
      : trimmed
    count += 1
  }
  return out
}

/** 面板一次带上多少条讲解注释、单条最多多少字。 */
const MAX_PANEL_COMMENTS = 200
const MAX_PANEL_COMMENT_CHARS = 600

/**
 * 工具调用 -> 「正在讲解的局面」的语义类别。
 * 面板棋盘靠它跟随讲解：模型讲到哪一手，棋盘就跳到哪一手。
 */
const FOCUS_KINDS = {
  go_parse_sgf: 'parse',
  go_review_moves: 'review',
  go_position_context: 'context',
  go_engine_analyze: 'engine',
  go_write_review: 'write',
}

/**
 * 从工具参数里取「这次调用在讲第几手」。
 * - go_position_context：参数里的 moveNumber 就是它；
 * - go_write_review：正在回写的注释手数就是讲解位置（取第一条）；
 * - 其余（读谱/找问题手/补算）：只知道在讲这盘棋，不知道第几手。
 * @param {string} kind FOCUS_KINDS 的值
 * @param {object|undefined} args 工具调用参数
 * @returns {number|undefined}
 */
function focusMoveNumber(kind, args) {
  if (kind === 'context') {
    const n = Math.trunc(Number(args?.moveNumber))
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  if (kind === 'write') {
    const first = Array.isArray(args?.entries) ? args.entries[0] : undefined
    const n = Math.trunc(Number(first?.moveNumber))
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return undefined
}

/**
 * 面板数据路由：给浏览器 half 的「问题手列表」提供结构化数据。
 *
 * 为什么必须有它：客户端插件拿不到工具的 execute（Host 工具面只暴露
 * register/schemas/get），也无法直接读盘；而本 half 拥有 ctx.fs 与
 * reviewGame，所以由 Host 读盘、算好、回 JSON，客户端只负责渲染。
 *
 * 只读、无副作用，且路径被约束在工作区根之下（resolve 归一化 +
 * contains 包含判断，挡住 ../ 逃逸），因此不设令牌。
 *
 * 软依赖 webServer：纯 CLI 组合（无 Web 服务器）下静默不装。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} cfg 已校验的插件配置
 */
function registerPanelRoute(ctx, cfg) {
  /**
   * 已知工作区根（最近成功的在前）。
   *
   * 为什么需要：浏览器端拿不到会话 cwd（客户端 SessionSnapshot 里没有这个字段，
   * 实测），所以相对路径常常没有可用的解析基准。但模型每次调用 go_* 工具时，
   * 工具都用 exec.agent.session.header.cwd 解析过路径 —— 那是权威的工作区根。
   * 这里把它记下来，作为面板相对路径的解析基准。
   */
  const roots = []
  /**
   * 「正在讲解的局面」指针：模型每次调用 go_* 工具就更新一次，
   * 面板棋盘轮询 /go-sensei/focus 后自动载入同一盘棋并跳到同一手。
   *
   * 为什么记在 Host：讲解发生在对话里（工具调用），而棋盘在浏览器里；
   * 两边唯一的共同信源就是 Host 观察到的工具调用。seq 单调递增，
   * 客户端据此判断"这条指针我处理过没有"，不必比较对象内容。
   */
  const focus = { seq: 0, value: null }
  ctx.on('tools/result', (exec, result) => {
    try {
      const name = exec?.name
      if (typeof name !== 'string' || name.indexOf('go_') !== 0) return
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') rememberRoot(cwd)
      // 失败的调用不改变讲解位置（模型经常先试错路径）
      if (result !== undefined && result?.isError === true) return
      const kind = FOCUS_KINDS[name]
      if (kind === undefined) return
      const rawPath = typeof exec?.arguments?.path === 'string' ? exec.arguments.path.trim() : ''
      if (rawPath === '') return
      const moveNumber = focusMoveNumber(kind, exec.arguments)
      focus.seq += 1
      focus.value = {
        seq: focus.seq,
        path: rawPath,
        cwd: typeof cwd === 'string' ? cwd : '',
        name: basename(rawPath),
        kind,
        ...(moveNumber !== undefined ? { moveNumber } : {}),
      }
    } catch {
      /* 观察者绝不干扰工具链路 */
    }
  })
  function rememberRoot(dir) {
    const index = roots.indexOf(dir)
    if (index === 0) return
    if (index > 0) roots.splice(index, 1)
    roots.unshift(dir)
    if (roots.length > 12) roots.length = 12
  }

  const mount = (webCtx) => {
    // 面板启动时读取已知工作区根（相对路径的解析候选）
    webCtx.webServer.register({
      kind: 'exact',
      path: '/go-sensei/roots',
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, roots: roots.slice() }))
      },
    })
    // 「正在讲解的局面」指针：棋盘跟随讲解用的轻量轮询端点（纯内存，不读盘）
    webCtx.webServer.register({
      kind: 'exact',
      path: '/go-sensei/focus',
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, focus: focus.value }))
      },
    })
    webCtx.webServer.register({
      kind: 'exact',
      path: '/go-sensei/review',
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requested = url.searchParams.get('path') ?? ''
          if (requested.trim() === '') {
            send(400, { ok: false, error: '缺少 path 参数' })
            return
          }
          // 解析基准顺序：浏览器带来的 cwd → 会话根（文档标签页给的是会话内相对路径）
          // → 已知工作区根（模型调过 go_* 才知道）→ 进程 cwd
          const candidates = []
          const explicit = url.searchParams.get('cwd')
          if (explicit) candidates.push(explicit)
          const sessionRoot = sessionRootOf(ctx, url.searchParams.get('session'))
          if (sessionRoot !== '') candidates.push(sessionRoot)
          for (const root of roots) candidates.push(root)
          candidates.push(panelDefaultRoot())

          let target
          let sawResolveSuccess = false
          let directoryHit = false
          let lastError = null
          for (const base of candidates) {
            let resolved
            try {
              resolved = await ctx.fs.resolve(requested, { cwd: base })
              sawResolveSuccess = true
            } catch (error) {
              if (lastError === null) lastError = String(error?.message ?? error)
              continue
            }
            let info
            try {
              info = await ctx.fs.stat(resolved, undefined)
            } catch (error) {
              if (lastError === null) lastError = String(error?.message ?? error)
              continue
            }
            if (info?.type === 'file') { target = resolved; break }
            if (info?.type === 'directory') directoryHit = true
          }
          if (target === undefined) {
            // 已知根之下按 basename 做有界发现：用户常见输入是「game.sgf」这种纯文件名，
            // 或「review-check/_accept/game.sgf」这种相对某个根的路径。
            target = await discoverUnderRoots(ctx, roots, requested)
          }
          if (target === undefined) {
            if (directoryHit) {
              send(400, { ok: false, error: `不是普通文件：${requested}` })
              return
            }
            if (sawResolveSuccess) {
              send(404, {
                ok: false,
                error: `找不到文件：${requested}`,
                hint: roots.length === 0
                  ? '还没有已知工作区根：先在对话里让 Sensei 复盘任意棋谱，或改用绝对路径。'
                  : '已知工作区根：' + roots.join(' | '),
              })
              return
            }
            send(500, { ok: false, error: lastError ?? `无法解析路径：${requested}` })
            return
          }
          // 成功即记住这个基准，让后续相对路径一次命中
          const baseDir = url.searchParams.get('cwd')
          if (baseDir) rememberRoot(baseDir)
          for (const root of roots) {
            if (target.displayPath.startsWith(root)) { rememberRoot(root); break }
          }
          // 复盘产物（分析数据 + 讲解）都写在 `-sensei` 副本里，源棋谱只读。
          // 面板按同一条规则取"工作文件"：副本存在就用副本 —— 否则用户在对话里
          // 复盘过的棋谱，在面板里会显示成"没有分析数据"（既缺首选/变化图，
          // 也会因为判定为无分析而现场重算几十秒）。
          const sourceTarget = target
          const sourcePath = sourceTarget.displayPath
          const derivedPath = senseiPathFor(sourcePath)
          if (derivedPath !== sourcePath) {
            const derivedTarget = await ctx.fs.resolve(derivedPath, { cwd: baseDir ?? undefined })
            const derivedInfo = await ctx.fs.stat(derivedTarget, undefined)
            if (derivedInfo?.type === 'file') target = derivedTarget
          }
          let bytes = await ctx.fs.readBytes(target, undefined, 64 * 1024 * 1024)
          let { text } = decodeBuffer(bytes)
          let game
          try {
            game = parseGame(text)
          } catch (error) {
            // 副本坏了（空文件/半截写入）不能让面板打不开棋谱：退回源棋谱。
            if (target === sourceTarget) throw error
            target = sourceTarget
            bytes = await ctx.fs.readBytes(target, undefined, 64 * 1024 * 1024)
            ;({ text } = decodeBuffer(bytes))
            game = parseGame(text)
          }
          // 与 go_review_moves 共用同一条管线：无分析数据且已配置引擎时自动补算。
          // 早期这里直接调 reviewGame，绕过了工具的自动补算 —— 同一份棋谱在对话里
          // 复盘能出问题手、面板却显示「未发现问题手」。同一业务逻辑只保留一份。
          const { autoEngine } = await autoComputeIfNeeded(ctx, cfg, game, {})
          const level = cfg.level === 'auto' ? inferLevel(game.info) : cfg.level
          const review = reviewGame(game, {
            winrateThreshold: cfg.winrateThreshold,
            scoreThreshold: cfg.scoreThreshold,
            pvDepth: cfg.pvDepth,
            maxPvCandidates: 3,
            maxCandidates: MAX_PANEL_CANDIDATES,
          })
          send(200, {
            ok: true,
            data: {
              path: target.displayPath,
              ...(sourcePath !== target.displayPath ? { sourcePath } : {}),
              mode: review.mode,
              level,
              moveCount: game.moves.length,
              variations: game.stats.variations,
              candidates: review.candidates.map(compactForPanel),
              board: compactBoard(game),
              // 逐手「AI 首选与变化图」：问题手列表之外的**讲解点**也要能在盘上标出来
              ai: compactAi(game, cfg),
              // 已写回棋谱的讲解：面板/整页/右侧栏都靠它显示"这一手怎么讲的"
              comments: compactComments(game),
              // 棋盘表头要显示"谁跟谁下、结果如何"，这些是讲解时最常用的一句话背景
              ...(game.info.players ? { players: game.info.players } : {}),
              ...(game.info.result !== undefined ? { result: game.info.result } : {}),
              ...(game.info.date !== undefined ? { date: game.info.date } : {}),
              ...(autoEngine !== undefined ? { autoEngine } : {}),
            },
          })
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
  }
  // 优先用 ctx.inject 等 webServer 出现（可选依赖，纯 CLI 组合下它永不到来）；
  // 拿不到 inject（极简上下文/单测桩）就退回即时 get，缺席时静默不挂路由。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mount)
    return
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) mount({ webServer })
}

/**
 * 在已知工作区根之下按 basename 做**有界**文件发现。
 *
 * 动机：浏览器拿不到会话 cwd，用户又常只写「game.sgf」或
 * 「review-check/_accept/game.sgf」这类相对写法。这里在每个已知根下做
 * 深度受限的目录遍历，命中同名文件即返回。
 *
 * 为什么有界：这些根可能是很大的目录，无界递归会拖慢请求。用
 * MAX_DISCOVER_DEPTH 限制层级、MAX_DISCOVER_VISITS 限制访问节点数，
 * 超限即放弃（回落到「找不到」并给出根列表提示）。
 *
 * @param {object} ctx Cordis 上下文（需 fs）
 * @param {string[]} roots 已知工作区根
 * @param {string} requested 用户输入的路径（取其 basename 匹配）
 * @returns {Promise<object|undefined>} 命中的 FsTarget，未命中返回 undefined
 */
async function discoverUnderRoots(ctx, roots, requested) {
  if (roots.length === 0) return undefined
  const wanted = String(requested).replace(/\\/g, '/').split('/').filter(Boolean).pop()
  if (wanted === undefined || wanted === '') return undefined
  let visits = 0
  for (const root of roots) {
    let rootTarget
    try {
      rootTarget = await ctx.fs.resolve(root, {})
    } catch {
      continue
    }
    const queue = [{ target: rootTarget, depth: 0 }]
    while (queue.length > 0) {
      const { target, depth } = queue.shift()
      if (visits >= MAX_DISCOVER_VISITS) return undefined
      visits += 1
      let entries
      try {
        entries = await ctx.fs.listDir(target, undefined)
      } catch {
        continue
      }
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (entry.type === 'file' && entry.name === wanted) return entry.target
        if (entry.type === 'directory' && depth < MAX_DISCOVER_DEPTH) {
          queue.push({ target: entry.target, depth: depth + 1 })
        }
      }
    }
  }
  return undefined
}

/** 文件发现的深度上限（层级）。 */
const MAX_DISCOVER_DEPTH = 3
/** 文件发现的访问节点上限，防止在大目录里遍历过久。 */
const MAX_DISCOVER_VISITS = 400

function personaOrder(ctx) {
  try {
    const base = Number(ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'))
    return Number.isFinite(base) ? base + 1 : 1
  } catch {
    return 1
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }

  ctx.systemPrompt.section({
    name: 'go-sensei:persona',
    order: personaOrder(ctx),
    text: buildPersona(cfg),
  })
  ctx.systemPrompt.section({
    name: 'tool:go-sensei',
    order: 3000,
    text: TOOL_GUIDANCE,
  })

  registerGoTools(ctx, cfg, new ReviewCache())
  registerPanelRoute(ctx, cfg)
}
