// index.mjs — DeepGo Sensei 宿主（Node）half
//
// 官方函数插件协议：具名导出 name/inject/Config/apply，无 default export
// （混用两种导出形态会被 Loader 丢弃命名空间，见官方 postmortem 0001）。
// 注册是 effect：工具与提示词段随插件 fiber 自动装卸。

import Schema from '@deepseek-ai/schemastery'
import { basename, dirname } from 'node:path'
import { registerGoTools, autoComputeIfNeeded, writeAnalysisBack, attachTerritory } from './src/tools.js'
import { resolveEngine } from './src/engine-resolve.js'
import { ReviewCache } from './src/cache.js'
import { RANKS, reviewGame, inferLevel, aiCandidatesByMove } from './src/review.js'
import { parseGame, decodeBuffer, compactBoard, winrateForColor, scoreForColor, hasTerritoryData, territoryOfMove, territorySeriesOf, MAX_SGF_CHARS } from './src/sgf.js'
import { senseiPathFor } from './src/derived.js'
import { buildGrid, parseSequence, parseMarks, renderBoardSvg } from './src/diagram.js'

export const name = 'go-sensei'
// 硬依赖：tools 注册工具、systemPrompt 挂人设段、fs 读写棋谱。
// 可选依赖（不得写进 inject，否则未挂载时整插件等待）：
//   sandboxPolicy —— 沙箱后端下写入必须携带它解析出的策略，见 src/tools.js。
//   webServer     —— 客户端面板的数据路由，见 registerPanelRoute。
//   connection    —— 面板路由的准入闸门（复用 GUI 的 Host/Origin 围栏 + 浏览器会话
//                    cookie 校验）。宿主监听 0.0.0.0 时它是这四条路由唯一的身份关卡。
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
5. 配图讲解：回答追问（尤其"第 N 手改下 X 会怎样""这里连没连上"）时，**必须**用 go_draw_diagram 生成配图，并在回答正文里用 Markdown 图片语法 \`![一句话说明](工具返回的 URL)\` 嵌入。图上的约定：变化着法按 1-9、A-Z 逐手编号（起始颜色由工具按局面自动定），关键棋子用 triangle（三角形）、square、circle、label（字母）标出；一张图只讲一个变化，图下配一句话说明。**绝不用文字描述代替配图，也绝不编造图片 URL**——URL 只能来自 go_draw_diagram 的返回值。
6. 形势判断：讲"这块地归谁""现在谁领先"时，用 go_draw_diagram 的 territory=true 叠加形势判断（**引擎归属图**判出的黑地/白地，未定处留白，图下附一行双方目数与领先）。判定口径照 Lizzieyzy：|归属| < 0.4 算未定、空点要过四邻过滤、落在对方地里的己方子按死子算，与面板的「形势判断」是同一份数据。该手若还没有归属数据，工具会当场补算一次（要等几十秒）；引擎不可用时它不出图并说明原因——此时就如实告诉学生"这次看不了形势判断"，不要改用估算糊弄。另外它与目差曲线（DM）不是同一个数：讲地盘归属用前者，讲领先多少目优先用后者，不要并排报两个数。
7. 工具纪律：先 go_parse_sgf 了解棋谱，再 go_review_moves 找问题手，逐手讲解后调用 go_write_review 写回 SGF 注释，需要落盘报告时用 go_export_report；同一局重复复盘优先复用工具返回的缓存结果（cached=true 时不再重复获取全量数据）；单局讲解预算约 ${cfg.tokenBudget} tokens，用"先问后讲"与数据裁剪控制消耗。`
}

const TOOL_GUIDANCE = `围棋复盘工具（DeepGo Sensei）：go_parse_sgf 读棋谱，go_review_moves 找问题手，go_position_context 取某手前后局面与 AI 候选，go_draw_diagram 画讲解配图（变化图编号 1-9/A-Z + 三角形等重点棋子标注；territory=true 可叠加形势判断——引擎归属图判出的黑地/白地（未定留白），图下附一行双方目数与领先；该手没有归属数据时会当场补算，引擎不可用则不出图并说明，返回可在对话里直接用 Markdown 图片语法嵌入的 URL），go_write_review 把讲解写回 SGF 的 C[] 注释，go_export_report 落盘 Markdown 报告，go_engine_info 查看/说明当前使用的 KataGo 引擎与权重。**源棋谱只读**：讲解与分析数据（胜率/目差/AI 首选与变化图）都写进同目录的 \`<源名>-sensei.sgf\` 副本，源文件永不修改；读取同一盘棋时若副本已存在（工具与面板都一样）就直接读副本，因为那才是上一次复盘的成果。补算引擎默认用插件自带的 engine 目录（开箱即用），也可用配置 engineDir / kataGoPath / kataGoModel 换成用户自己的引擎与权重。路径参数支持绝对路径或相对当前会话工作区的相对路径。`

/** 配图 URL 的基地址（形如 http://127.0.0.1:3080）；由 webServer 挂载时填充。 */
function createDiagramBase() {
  return { base: '' }
}

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
 * 逐手曲线：胜率与目差，**统一为黑棋视角**（用户 2026-09-14 的要求）。
 *
 * 为什么在宿主换算而不是把原始 WV/DM/LZ 推给浏览器：棋谱里的三套数据口径
 * 各不相同（WV 白方视角、DM 黑方视角、LZ 落子者视角、注释里的"胜率"又是
 * 落子者视角），浏览器侧再做换算就是第二份实现，迟早与前缀口径漂移。
 * 这里用 sgf.js 的 winrateForColor / scoreForColor 一次算清：
 *   · 正胜率 = 黑好，正目差 = 黑领先。
 *
 * 下标 i 对应「第 i+1 手之后的局面」（分析属性记的正是落子后的盘面）；
 * 该手没有数据时为 null，曲线在缺口处断开。
 *
 * @param {object} game parseGame 的返回值
 * @returns {{ winrate: Array<number|null>, score: Array<number|null> }}
 */
function compactCurve(game) {
  const moves = (game.moves ?? []).slice(0, MAX_PANEL_CURVE_MOVES)
  const winrate = []
  const score = []
  for (const move of moves) {
    const w = winrateForColor(move, 'B')
    const s = scoreForColor(move, 'B')
    winrate.push(w === undefined ? null : round1(w * 100))
    score.push(s === undefined ? null : round1(s))
  }
  return { winrate, score }
}

/** 曲线最多带回多少手（正常一局 ≤ 400 手，防御性上限）。 */
const MAX_PANEL_CURVE_MOVES = 400

/**
 * 面板用的逐手形势判断。
 *
 * 下发的是**已经判好的三档图**（`map`，packTerritory 的 base64）外加那几行数字 ——
 * 客户端只画不算，因此不存在"两端算法漂移"的可能（v0.2.8 的启发式就是因为
 * 宿主与客户端各写一份，才需要专门的探针逐点对拍）。
 *
 * 数字在宿主这边算，是因为面板浮窗要显示提子；提子要重放棋谱，客户端不必再实现一遍。
 *
 * @param {object} game parseGame 的返回值
 * @returns {{ available: boolean, komi?: number, step?: Array<object|null> }}
 */
function compactTerritory(game) {
  if (!hasTerritoryData(game)) return { available: false }
  const step = territorySeriesOf(game).map((item) =>
    item === null
      ? null
      : {
          map: item.packed,
          blackPoints: item.est.blackPoints,
          whitePoints: item.est.whitePoints,
          lead: item.est.lead,
          capturedBlack: item.est.capturedBlack,
          capturedWhite: item.est.capturedWhite,
          deadBlack: item.est.deadBlack,
          deadWhite: item.est.deadWhite,
        })
  return { available: true, komi: game?.info?.komi ?? 0, step }
}

/** 四舍五入到 1 位小数；非有限值返回 null（面板侧 null 表示缺口）。 */
function round1(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const r = Math.round(n * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

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
  go_draw_diagram: 'diagram',
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
  if (kind === 'context' || kind === 'diagram') {
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
 * **准入**：四条路由都先过 panelRejection() —— 复用 connection 服务的
 * requestRejection()，即与 GUI 的 /api 完全同一道闸门（Host/Origin 围栏 +
 * 浏览器会话 cookie）。宿主默认监听 0.0.0.0，这些路由又接受调用方给的路径，
 * 没有这道闸门就等于把「读本机文件」的 API 挂到局域网上（2026-09 安全复核）。
 * 因此面板可用性与 GUI 严格一致：能登录 GUI 的浏览器就能用面板，其余一律 401。
 *
 * 软依赖 webServer：纯 CLI 组合（无 Web 服务器）下静默不装。
 * 软依赖 connection：缺席时退回「仅本机来源」，局域网面板随之不可用（宁可如此）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} cfg 已校验的插件配置
 * @param {{ base: string }} diagram 配图基地址（由本函数在挂载时填充，供 go_draw_diagram 使用）
 */
function registerPanelRoute(ctx, cfg, diagram) {
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
  /**
   * 「正在讲解的局面」指针：**按会话分桶**。
   *
   * 为什么要分桶：宿主进程只有一个，而 GUI 支持多会话并存。单个全局指针会让 A 会话里
   * 的一次工具调用把 B 会话面板里的棋谱顶掉（2026-09 实核）。序号仍是全局单调的 ——
   * 客户端只靠 seq 判断"这条我处理过没有"，分桶不影响这个语义。
   *
   * 桶数上限 32：会话是有限资源，但指针不该无界增长（LRU：最久未更新的先淘汰）。
   */
  const focusBySession = new Map()
  const FOCUS_MAX_SESSIONS = 32
  let focusSeq = 0
  /** 最近一次指针：没带 ?session= 的请求（旧客户端/整页视图）按它返回。 */
  let focusLatest = null

  /**
   * 记下一条指针。
   * @param {string} sessionId 会话 id；空串时只更新"最近一次"
   * @param {object} value 指针内容（不含 seq）
   */
  function rememberFocus(sessionId, value) {
    focusSeq += 1
    const pointer = { seq: focusSeq, ...value }
    focusLatest = pointer
    if (typeof sessionId === 'string' && sessionId !== '') {
      focusBySession.delete(sessionId)
      focusBySession.set(sessionId, pointer)
      while (focusBySession.size > FOCUS_MAX_SESSIONS) {
        focusBySession.delete(focusBySession.keys().next().value)
      }
    }
    return pointer
  }

  /**
   * 取某会话的指针。
   * @param {string|null} sessionId
   * @returns {object|null} 该会话还没讲过时为 null（客户端会跳过，不会误跟别人的局面）
   */
  function focusFor(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      return focusBySession.get(sessionId) ?? null
    }
    return focusLatest
  }
  /**
   * 面板/配图路由的 dispose 函数。webServer.register 返回「移除该路由」的 disposer；
   * DSH 0.1.6 起宿主支持插件运行时卸载，路由必须随本插件 fiber 一起释放，否则停用
   * 插件后路由仍然挂着。这里**同步**登记回收动作（此刻 fiber 必定有效），dispose 时
   * 再读数组，因此晚到的 mount（ctx.inject 是异步的）也能被覆盖。
   */
  const routeOffs = []
  ctx.effect(() => () => {
    for (const off of routeOffs.splice(0)) {
      try { off() } catch { /* 卸载阶段的清理失败不阻塞其它清理 */ }
    }
  })
  ctx.on('tools/result', (exec, result) => {
    try {
      const name = exec?.name
      if (typeof name !== 'string' || name.indexOf('go_') !== 0) return
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') rememberRoot(cwd)
      // 失败的调用不改变讲解位置（模型经常先试错路径）
      if (result !== undefined && result?.isError === true) return
      const rawPath = typeof exec?.arguments?.path === 'string' ? exec.arguments.path.trim() : ''
      // 成功的 go_* 调用：把棋谱所在目录也记进 roots。面板与配图路由随后要按绝对路径
      // 打开同一盘棋，而读取前的包含校验（readRefusal）只认这些根 —— 不记的话，
      // 工作区之外的棋谱会被自家闸门拒掉（2026-09 复核）。
      //
      // 信任前提（复审对"白名单可被工具参数污染"这条 High 的说明）：path 来自**模型自己
      // 的工具参数**，且只在调用成功时登记；模型本来就能用 read 读任意文件，所以登记一个
      // 目录不构成权限提升 —— 它只是让面板/配图这两条浏览器路由能读同一盘棋。
      if (rawPath !== '') {
        const dir = dirname(rawPath)
        if (dir !== '' && dir !== '.' && dir !== rawPath) rememberRoot(dir)
      }
      const kind = FOCUS_KINDS[name]
      if (kind === undefined) return
      if (rawPath === '') return
      const moveNumber = focusMoveNumber(kind, exec.arguments)
      const focusSessionId = exec?.agent?.session?.header?.id
      rememberFocus(typeof focusSessionId === 'string' ? focusSessionId : '', {
        path: rawPath,
        cwd: typeof cwd === 'string' ? cwd : '',
        name: basename(rawPath),
        kind,
        ...(moveNumber !== undefined ? { moveNumber } : {}),
      })
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

  /** 目录基准的比较形式：统一分隔符、去掉尾斜杠，Windows 下忽略大小写。 */
  function normalizeBase(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return ''
    const slashed = text.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed
  }

  const LOOPBACK_REMOTE = /^(?:::1|::ffff:127(?:\.\d+){3}|127(?:\.\d+){3})$/

  /** 请求是否来自本机（没有 connection 服务时的回退判据）。 */
  function isLoopbackRequest(req) {
    const remote = req?.socket?.remoteAddress
    return typeof remote === 'string' && LOOPBACK_REMOTE.test(remote)
  }

  /** Host 与 Origin 必须同源；带 cross-site 标记的请求直接拒绝（挡跨站与 DNS rebinding）。 */
  function sameOriginRequest(req) {
    const headers = req?.headers
    if (headers === undefined) return false
    if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
    const origin = headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      return new URL(origin).host === String(headers.host ?? '')
    } catch {
      return false
    }
  }

  /** 没有 connection 服务时是否已经提醒过（同一进程只提醒一次）。 */
  let warnedNoConnection = false

  /**
   * 面板路由的准入闸门。
   *
   * @param {object} req Node 请求
   * @returns {number|undefined} 放行返回 undefined；否则返回 401（无有效会话凭据）
   *   或 403（Host/Origin 围栏拒绝）
   */
  function panelRejection(req) {
    let connection
    try {
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      connection = undefined
    }
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        return connection.requestRejection(req)
      } catch {
        return 401
      }
    }
    if (!warnedNoConnection) {
      warnedNoConnection = true
      ctx.logger?.warn?.(
        'go-sensei：未找到 connection 服务，面板路由退回「仅本机来源」模式；局域网将无法访问面板',
      )
    }
    if (!sameOriginRequest(req)) return 403
    return isLoopbackRequest(req) ? undefined : 401
  }

  /**
   * /go-sensei/review 的自限速。
   *
   * 这条路由在棋谱没有分析数据时会现场启动 KataGo（CPU/GPU 密集），并读盘 +
   * 解析 SGF。没有上限时，一个循环请求（甚至一个网页的定时 fetch）就能把机器
   * 拖住，所以这里同时限制「在飞请求数」与「窗口内请求数」。
   */
  const REVIEW_WINDOW_MS = 10_000
  const REVIEW_MAX_PER_WINDOW = 20
  const REVIEW_MAX_INFLIGHT = 2
  const reviewWindow = []
  let reviewInflight = 0

  /** @returns {number|undefined} 超限时返回 429/503。 */
  function reviewThrottle() {
    const now = Date.now()
    while (reviewWindow.length > 0 && now - reviewWindow[0] > REVIEW_WINDOW_MS) reviewWindow.shift()
    if (reviewInflight >= REVIEW_MAX_INFLIGHT) return 503
    if (reviewWindow.length >= REVIEW_MAX_PER_WINDOW) return 429
    reviewWindow.push(now)
    return undefined
  }

  /**
   * 词法归一化：丢掉 '.' 段、'..' 段回退一级。
   *
   * 为什么比较前必须做：包含校验若只做字符串前缀比较，而 displayPath 里残留未归一化
   * 的 `..` 段（形如 `C:/root/../../etc/passwd`），前缀比较就会把"看着在根里、其实在
   * 根外"的路径判为放行（2026-09 复审发现）。归一化是纯词法操作，不访问文件系统。
   * 符号链接不在本层解决：DSH 的 fs 服务对**读取**不做收敛（读取在所有策略下都放行），
   * 插件层能做的只是"不让这条路由成为任意文件/存在性探针"，不是当第二层沙箱。
   */
  function normalizeSegments(value) {
    const out = []
    for (const part of normalizeBase(value).split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') { out.pop(); continue }
      out.push(part)
    }
    return out.join('/')
  }

  /**
   * 目标是否落在某个根之下（归一化 + 统一分隔符 + Windows 忽略大小写）。
   *
   * 用前缀比较而不是 path.relative：displayPath 由 fs 服务给出，正反斜杠可能混用，
   * 而归一化后两边都是 '/' 分隔的段序列。相等也算在内（根本身就是那个文件时）。
   */
  function pathWithin(root, target) {
    const a = normalizeSegments(root)
    const b = normalizeSegments(target)
    if (a === '' || b === '') return false
    if (b === a) return true
    return b.startsWith(a.endsWith('/') ? a : `${a}/`)
  }

  /**
   * 允许读取的根集合：会话根（宿主按 id 反查，权威）→ 已知工作区根 → 面板默认根。
   *
   * 已知工作区根由 tools/result 观察者维护：既含各会话的工作区 cwd，也含**模型复盘过的
   * 棋谱所在目录**（本轮新增）—— 后者是"工作区之外的棋谱照样能配图/上面板"的保证。
   *
   * 注意**不含**请求里的 ?cwd：它完全由调用方给定，若拿它当放行依据，包含校验会自我作废。
   *
   * 根列表是**进程级共享**的（同一用户的多个会话之间不隔离）：它代表"这台机器上用户
   * 自己复盘过的目录"，不是会话私有资源；真正的身份关卡是上面的 panelRejection。
   */
  function allowedReadRoots(sessionId) {
    const list = []
    const sessionRoot = sessionRootOf(ctx, sessionId)
    if (sessionRoot !== '') list.push(sessionRoot)
    for (const root of roots) list.push(root)
    list.push(panelDefaultRoot())
    return list
  }

  /**
   * 面板写回用的沙箱策略。
   *
   * 这条路由没有工具执行上下文，所以按请求带来的会话 id 反查会话对象再解析策略
   * （与 tools.js 里 `resolve({ session })` 同一语义）；拿不到会话就退回不带会话的解析。
   * 仍然拿不到策略时**不硬造**：这一次只把归属图随响应下发，不落盘。
   *
   * 为什么必须带策略：沙箱后端以写入携带的策略为越界判定的唯一依据，省略即退回服务
   * 默认策略（在受限会话里表现为"偶发被拒"，无沙箱后端时则等于绕过工作区限制）。
   *
   * @returns {object|null} 可用的策略；拿不到时 null（调用方跳过写回）
   */
  function panelWritePolicy(ctx, sessionId) {
    const notes = []
    try {
      const service = ctx.get('sandboxPolicy')
      if (service === undefined || service === null || typeof service.resolve !== 'function') {
        return { policy: null, reason: '没有 sandboxPolicy 服务' }
      }
      let session
      if (typeof sessionId === 'string' && sessionId !== '') {
        const sessions = ctx.get('sessions')
        if (sessions === undefined || typeof sessions.get !== 'function') {
          notes.push('没有 sessions 服务')
        } else {
          // 会话 id 的写法随 DSH 版本变过（有的带 `session-` 前缀、有的是裸 uuid），
          // 两种都试一遍：拿不到会话就只能退回部署默认策略（本机是 read-only，写必被拒）。
          const ids = [sessionId]
          if (sessionId.startsWith('session-')) ids.push(sessionId.slice('session-'.length))
          for (const id of ids) {
            try {
              const found = sessions.get(id)
              if (found !== undefined && found !== null) {
                session = found
                notes.push(`sessions.get 命中（${id.slice(0, 18)}…）`)
                break
              }
            } catch (error) {
              notes.push(`sessions.get 抛错：${String(error?.message ?? error).slice(0, 60)}`)
            }
          }
          if (session === undefined) notes.push('sessions.get 没查到该会话')
        }
      } else {
        notes.push('请求没带 session 参数')
      }
      // 先按会话解析（模式取该会话的 sandbox/mode，root 取会话 cwd）；拿不到再退回部署默认
      const attempts = session !== undefined && session !== null ? [{ session }, {}] : [{}]
      for (const arg of attempts) {
        try {
          const policy = service.resolve(arg)
          if (policy !== null && policy !== undefined) {
            return {
              policy,
              reason: `${arg.session ? '按会话' : '按部署默认'}解析：mode=${policy.mode} root=${policy.workspaceRoot}（${notes.join('，')}）`,
            }
          }
          notes.push(arg.session ? 'resolve(会话) 返回 null' : 'resolve(默认) 返回 null')
        } catch (error) {
          notes.push(`${arg.session ? 'resolve(会话)' : 'resolve(默认)'} 抛错：${String(error?.message ?? error).slice(0, 80)}`)
        }
      }
      return { policy: null, reason: notes.join(' | ') }
    } catch (error) {
      return { policy: null, reason: `外层异常：${String(error?.message ?? error).slice(0, 80)}` }
    }
  }

  /** 请求里给的路径看起来是不是绝对路径（Windows 盘符 / UNC / POSIX 根）。 */
  function looksAbsolute(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return false
    return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//') || text.startsWith('/')
  }

  /**
   * 读取前的包含校验。
   *
   * 为什么必须拦在 readBytes 之前：/review 与 /diagram 都拿调用方给的 ?path 直接解析
   * 并读盘，使这两条路由成了任意文件读取与**存在性探针**（404 与 500 可区分）。鉴权只
   * 解决"谁能打进来"，这里解决"打进来之后能读什么"（2026-09 复核）。
   *
   * @param {object|string} target FsTarget 或路径字符串
   * @param {string|null} sessionId 请求带来的会话 id
   * @returns {string|undefined} 放行返回 undefined；否则返回给用户看的原因
   */
  function readRefusal(target, sessionId) {
    const display = typeof target === 'string' ? target : target?.displayPath
    if (typeof display !== 'string' || display === '') return '无法确定文件位置'
    for (const root of allowedReadRoots(sessionId)) {
      if (pathWithin(root, display)) return undefined
    }
    return `文件不在已知工作区内：${display}`
  }

  /** 文件落在允许根之外时的统一提示（404 与 403 口径一致，便于用户照做）。 */
  const OUTSIDE_HINT = '相对路径的解析基准是会话工作区；已知工作区之外的文件请先在对话里'
    + '让 Sensei 复盘它（宿主会记下它所在的目录，之后面板与配图就能按绝对路径打开）。'

  const mount = (webCtx) => {
    /**
     * 配图的基地址：优先用**请求自带的 Host 头**（用户可能从 localhost / 局域网 IP /
     * 别的端口访问，写死 127.0.0.1 会让图片 404），拿不到才退回服务自己报的 host:port。
     * 面板每 3 秒轮询一次 /go-sensei/focus，所以正常使用下 Host 头很快就有值。
     */
    const server = webCtx?.webServer
    if (server !== undefined && typeof server.port === 'number' && server.port > 0) {
      const host = server.host === '0.0.0.0' ? '127.0.0.1' : String(server.host ?? '127.0.0.1')
      diagram.base = `http://${host}:${server.port}`
    }
    // 每条路由登记后立刻收集它的 dispose 函数（回收动作见 apply 顶部的 routeOffs）。
    const addRoute = (route) => {
      const off = webCtx.webServer.register(route)
      if (typeof off === 'function') routeOffs.push(off)
    }
    /**
     * 闸门拒绝时的统一响应。
     *
     * 不回显任何业务数据，也**不调用 rememberHost** —— 否则一次未授权的
     * 伪造 Host 请求就能改掉后续配图链接的基地址。
     */
    const deny = (res, status) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' }))
    }
    /**
     * 配图基地址：只接受语法合法的 authority（host[:port]）。
     *
     * 该值会写进对话里的图片 URL，所以不能让请求头里的任意字符串（含路径、
     * 空白、非法字符）落进来；所有调用点都排在 panelRejection() 之后。
     */
    const rememberHost = (req) => {
      const raw = req?.headers?.host
      if (typeof raw !== 'string' || raw === '') return
      let authority
      try {
        authority = new URL(`http://${raw}`).host
      } catch {
        return
      }
      if (authority === '' || /[^A-Za-z0-9._:[\]-]/.test(authority)) return
      diagram.base = `http://${authority}`
    }
    // 面板启动时读取已知工作区根（相对路径的解析候选）
    addRoute({
      kind: 'exact',
      path: '/go-sensei/roots',
      handler: (req, res) => {
        const rejection = panelRejection(req)
        if (rejection !== undefined) {
          deny(res, rejection)
          return
        }
        rememberHost(req)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, roots: roots.slice() }))
      },
    })
    // 「正在讲解的局面」指针：棋盘跟随讲解用的轻量轮询端点（纯内存，不读盘）
    addRoute({
      kind: 'exact',
      path: '/go-sensei/focus',
      handler: (req, res) => {
        const rejection = panelRejection(req)
        if (rejection !== undefined) {
          deny(res, rejection)
          return
        }
        rememberHost(req)
        // 按会话返回：没带 ?session= 时退回"最近一次"（旧客户端与整页视图的行为不变）。
        // 不额外校验 session 归属（复审对"IDOR"这条 High 的说明）：GUI 是单用户的、
        // 侧栏本就列出全部会话，持有效 cookie 的调用者能看到所有会话；指针内容也只是
        // "哪盘棋、第几手"。真正的身份关卡是上面那道 panelRejection。
        const focusUrl = new URL(req.url ?? '/', 'http://localhost')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, focus: focusFor(focusUrl.searchParams.get('session')) }))
      },
    })
    // 讲解配图：把「局面 + 变化图 + 重点棋子标注」画成一张 SVG 图片直接回给浏览器，
    // 于是对话正文里一个 `![](/go-sensei/diagram?…)` 就能显示出来（图片源是绝对 URL 时
    // 聊天区按原样渲染 <img>）。参数即全部输入，无状态 —— 重启后旧链接照样能打开。
    addRoute({
      kind: 'exact',
      path: '/go-sensei/diagram',
      handler: async (req, res) => {
        const rejection = panelRejection(req)
        if (rejection !== undefined) {
          deny(res, rejection)
          return
        }
        rememberHost(req)
        const fail = (status, message) => {
          res.statusCode = status
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(message)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requested = (url.searchParams.get('path') ?? '').trim()
          if (requested === '') {
            fail(400, '缺少 path 参数')
            return
          }
          const sessionId = url.searchParams.get('session')
          // 绝对路径不经任何解析基准、直接落到文件系统：先做一次纯字符串的包含校验，
          // 连 stat 都不做，避免把"这个文件存不存在"泄露给已知工作区之外的目标。
          if (looksAbsolute(requested)) {
            const refusedEarly = readRefusal(requested, sessionId)
            if (refusedEarly !== undefined) {
              fail(404, refusedEarly)
              return
            }
          }
          const sourceTarget = await ctx.fs.resolve(requested, {})
          let target = sourceTarget
          // 复盘副本优先（分析数据在它里面）；副本不存在就用调用者给的源棋谱。
          const derivedPath = senseiPathFor(sourceTarget.displayPath)
          if (derivedPath !== sourceTarget.displayPath) {
            const derivedTarget = await ctx.fs.resolve(derivedPath, {})
            const derivedInfo = await ctx.fs.stat(derivedTarget, undefined)
            if (derivedInfo?.type === 'file') target = derivedTarget
          }
          const info = await ctx.fs.stat(target, undefined)
          if (info?.type !== 'file') {
            fail(404, `找不到棋谱：${requested}`)
            return
          }
          // 读取前的权威闸门：解析结果必须落在允许的根之内（symlink 跳转也在这里兜住）。
          const outsideRefusal = readRefusal(target, sessionId)
          if (outsideRefusal !== undefined) {
            fail(404, outsideRefusal)
            return
          }
          const bytes = await ctx.fs.readBytes(target, undefined, MAX_SGF_CHARS)
          const { text } = decodeBuffer(bytes)
          const game = parseGame(text)
          const size = game.info?.size ?? 19
          const board = compactBoard(game)
          const total = board.moves.length
          const rawMove = url.searchParams.get('move')
          const parsed = rawMove === null || rawMove.trim() === '' ? total : Math.trunc(Number(rawMove))
          const move = Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : total, total))
          const grid = buildGrid(board, move)
          // 第 move 手之后的盘面：轮到的是那一手的对手（move=0 时黑先）
          const firstColor = move === 0 ? 'B' : board.moves[move - 1].c === 'B' ? 'W' : 'B'
          const sequence = parseSequence(
            (url.searchParams.get('seq') ?? '').split(',').filter((t) => t.trim() !== ''),
            size,
            firstColor,
          )
          const marks = parseMarks(
            (url.searchParams.get('marks') ?? '').split(',').filter((t) => t.trim() !== ''),
            size,
          )
          const rawWidth = Math.trunc(Number(url.searchParams.get('w')))
          const lastMove = move > 0 && board.moves[move - 1].x >= 0 ? board.moves[move - 1] : null
          // 形势判断（用户 2026-09-19 定案，照 Lizzieyzy 的规则）：读棋谱副本里已有的
          // 归属图（TP[]，与胜率/目差同一次补算产出），把它画成黑/白小方块并在盘下附一行。
          // **这里不跑引擎**：补算由工具侧 autoComputeIfNeeded 或面板的「形势判断」按钮触发
          // （那一步会把 TP[] 写回副本），所以这条路由始终是毫秒级、不阻塞图片加载。
          const wantTerritory = url.searchParams.get('territory') === '1'
          const territoryHit = wantTerritory ? territoryOfMove(game, move) : null
          const svg = renderBoardSvg({
            size,
            grid,
            numbered: sequence.points,
            marks: marks.marks,
            lastMove,
            caption: (url.searchParams.get('cap') ?? '').slice(0, 120),
            // 形势判断附在图注之下（两行都在盘下，视口高度按两行一起加）
            ...(territoryHit !== null
              ? { territory: territoryHit.est.cells, footer: territoryHit.text }
              : {}),
            // 黑方白方的名字直接画在盘上沿：配图在对话正文里，四周没有别的说明
            players: game.info?.players,
            width: Number.isFinite(rawWidth) && rawWidth >= 120 ? Math.min(rawWidth, 1600) : 640,
          })
          res.statusCode = 200
          res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
          // 参数即全部输入，但内容可能随棋谱变化（重新复盘后注释/分析都变），故不缓存。
          res.setHeader('cache-control', 'no-store')
          res.end(svg)
        } catch (error) {
          // 同 review：原始异常只进日志，响应里只给一句通用文案。
          ctx.logger?.warn?.(`go-sensei：面板配图失败：${String(error?.message ?? error)}`)
          fail(500, '配图失败')
        }
      },
    })
    addRoute({
      kind: 'exact',
      path: '/go-sensei/review',
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        const rejection = panelRejection(req)
        if (rejection !== undefined) {
          deny(res, rejection)
          return
        }
        const throttled = reviewThrottle()
        if (throttled !== undefined) {
          send(throttled, {
            ok: false,
            error: throttled === 429 ? '请求过于频繁，请稍后再试' : '正在读取上一份棋谱，请稍后再试',
          })
          return
        }
        reviewInflight += 1
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requested = url.searchParams.get('path') ?? ''
          if (requested.trim() === '') {
            send(400, { ok: false, error: '缺少 path 参数' })
            return
          }
          // 允许读取的根：会话根（宿主按 id 反查）→ 已知工作区根 → 面板默认根。
          // 解析候选**只从这里取**，不含请求带来的 ?cwd —— 那个值完全由调用方给定，
          // 拿它当放行/解析依据会让包含校验自我作废（2026-09 复核）。
          const sessionId = url.searchParams.get('session')
          const allowedRoots = allowedReadRoots(sessionId)
          const candidates = []
          for (const root of allowedRoots) candidates.push(root)
          const rawBaseDir = url.searchParams.get('cwd')
          const baseDir = typeof rawBaseDir === 'string' && rawBaseDir.trim() !== '' ? rawBaseDir : null
          // ?cwd 只作解析基准，且**仅当它本身已是允许的根**（正常情形＝本会话工作区）；
          // roots 仍只由工具执行与会话根补充，一次请求改不动它。
          const persistBase = baseDir !== null
            && allowedRoots.some((root) => normalizeBase(root) === normalizeBase(baseDir))
          if (baseDir !== null && persistBase) candidates.unshift(baseDir)
          // 调用方给了基准、但那个基准不在允许根之内：直接拒绝 —— 既不拿它解析、
          // 也不做任何 stat（否则 ?cwd 就成了绕过包含校验的跳板，且成了目录探针）。
          if (baseDir !== null && !persistBase) {
            send(404, { ok: false, error: `基准目录不在已知工作区内：${baseDir}`, hint: OUTSIDE_HINT })
            return
          }
          // 绝对路径不经过任何基准、直接落到文件系统：先做一次纯字符串的包含校验，
          // 连 stat 都不做，避免把"这个文件存不存在"泄露给已知工作区之外的目标。
          if (looksAbsolute(requested)) {
            const refusedEarly = readRefusal(requested, sessionId)
            if (refusedEarly !== undefined) {
              send(404, { ok: false, error: refusedEarly, hint: OUTSIDE_HINT })
              return
            }
          }

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
              // 只给可操作的建议，不回带宿主的根列表（那属于服务端内部信息）。
              send(404, {
                ok: false,
                error: `找不到文件：${requested}`,
                hint: OUTSIDE_HINT,
              })
              return
            }
            ctx.logger?.warn?.(`go-sensei：面板无法解析路径 ${requested}：${lastError ?? '未知原因'}`)
            send(500, { ok: false, error: `无法解析路径：${requested}` })
            return
          }
          // 本来就是已知根的基准提到最前（缓存热点）；调用方新给的目录不写进 roots。
          if (persistBase && baseDir !== null) rememberRoot(baseDir.trim())
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
          // 读取前的权威闸门：最终要读的那个文件必须落在允许的根之内。放在 readBytes
          // 之前 —— 内容一个字节都不出宿主；相对路径由上面受限的候选基准保证，
          // 绝对路径与 symlink 跳转由这一次判定兜住（2026-09 复核）。
          const outsideRefusal = readRefusal(target, sessionId)
          if (outsideRefusal !== undefined) {
            send(404, { ok: false, error: outsideRefusal, hint: OUTSIDE_HINT })
            return
          }
          let bytes = await ctx.fs.readBytes(target, undefined, MAX_SGF_CHARS)
          let { text } = decodeBuffer(bytes)
          let game
          try {
            game = parseGame(text)
          } catch (error) {
            // 副本坏了（空文件/半截写入）不能让面板打不开棋谱：退回源棋谱。
            if (target === sourceTarget) throw error
            target = sourceTarget
            bytes = await ctx.fs.readBytes(target, undefined, MAX_SGF_CHARS)
            ;({ text } = decodeBuffer(bytes))
            game = parseGame(text)
          }
          // 原文与写回目标必须挂在 game 上：writeAnalysisBack 第一件事就是取 `_meta.text`，
          // 缺了它一律返回 undefined（表现为「点了形势判断、补算跑完，却什么都没写」——
          // 真机踩过：策略解析完全正常，只是这一步没有原文可改）。与 tools.js 的
          // readGameFile 同一形状：sourcePath 是源棋谱，写回目标永远由它推出（-sensei 副本）。
          game._meta = {
            path: target.displayPath,
            sourcePath,
            derived: target.displayPath !== sourcePath,
            text,
          }
          // 与 go_review_moves 共用同一条管线：无分析数据且已配置引擎时自动补算。
          // 早期这里直接调 reviewGame，绕过了工具的自动补算 —— 同一份棋谱在对话里
          // 复盘能出问题手、面板却显示「未发现问题手」。同一业务逻辑只保留一份。
          //
          // ?territory=1 表示用户点了面板上的「形势判断」按钮（**明确的分析动作**）：
          //   · 缺归属图时允许再跑一次引擎（老副本只有 WV/DM/LZ、没有 TP[]）
          //   · 算完把归属图写回副本（与工具侧同一份 writeAnalysisBack），以后秒开
          // 只读路径（不带这个参数）依旧不写盘 —— 写回只发生在明确的分析动作里。
          const wantTerritory = url.searchParams.get('territory') === '1'
          const { autoEngine } = await autoComputeIfNeeded(ctx, cfg, game, {
            ...(wantTerritory ? { needTerritory: true } : {}),
          })
          let territorySaved = false
          let territoryWrite
          if (wantTerritory) {
            // **先**把归属图算出来挂到棋局上：面板能不能看到地盘，与能不能落盘是两件事。
            // 早期把这一步放进写回函数里，写回一失败响应里连数据都没有（真机踩过：
            // 补算跑了 35 秒、结果 territory.available 还是 false）。
            const attached = attachTerritory(game)
            // 「有归属图就尝试落盘」——不能只在"本次真的跑了引擎"时才写：补算结果命中
            // 内存缓存时同样要落盘（否则先打开棋谱触发的补算不写盘、再点形势判断又被
            // 缓存接住，磁盘上永远没有 TP[]）。attachTerritory 返回 0 表示本来就没有
            // 归属图可写，那就什么都不做。
            if (attached > 0) {
              const resolved = panelWritePolicy(ctx, sessionId)
              territoryWrite = { reason: resolved.reason, attached }
              if (resolved.policy === null) {
                ctx.logger?.warn?.(`go-sensei：面板拿不到写回策略（${resolved.reason}），归属图只随本次响应下发`)
              } else {
                try {
                  const written = await writeAnalysisBack(ctx, undefined, resolved.policy, game)
                  territorySaved = written !== undefined
                  territoryWrite.ok = territorySaved
                  if (!territorySaved) territoryWrite.error = '没有可写内容'
                } catch (error) {
                  territoryWrite.ok = false
                  territoryWrite.error = String(error?.message ?? error).slice(0, 300)
                  ctx.logger?.warn?.(`go-sensei：面板写回归属图失败：${territoryWrite.error}`)
                }
              }
            }
          }
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
              // 逐手胜率 / 目差曲线（统一黑棋视角）：三处视图据此画可折叠曲线图
              curve: compactCurve(game),
              // 逐手「AI 首选与变化图」：问题手列表之外的**讲解点**也要能在盘上标出来
              ai: compactAi(game, cfg),
              // 已写回棋谱的讲解：面板/整页/右侧栏都靠它显示"这一手怎么讲的"
              comments: compactComments(game),
              // 形势判断：逐手三档图 + 双方目数/提子/领先（面板的浮窗与盘上色块都用它）
              territory: compactTerritory(game),
              // 「形势判断」按钮的可用性：引擎不可用且还没有归属数据时，客户端要禁用并说明原因
              engineAvailable: (() => {
                try {
                  return resolveEngine(cfg).available === true
                } catch {
                  return false
                }
              })(),
              // 这次补算出来的归属图有没有真的写回副本（没写回时下次打开会重算）
              territorySaved,
              ...(territoryWrite !== undefined ? { territoryWrite } : {}),
              // 棋盘表头要显示"谁跟谁下、结果如何"，这些是讲解时最常用的一句话背景
              ...(game.info.players ? { players: game.info.players } : {}),
              ...(game.info.result !== undefined ? { result: game.info.result } : {}),
              ...(game.info.date !== undefined ? { date: game.info.date } : {}),
              ...(autoEngine !== undefined ? { autoEngine } : {}),
            },
          })
        } catch (error) {
          // 具体原因只进日志：回给客户端的消息里不回带宿主路径与原始异常。
          ctx.logger?.warn?.(`go-sensei：面板读取棋谱失败：${String(error?.message ?? error)}`)
          send(500, { ok: false, error: '读取棋谱失败', code: 'panel-read-failed' })
        } finally {
          reviewInflight -= 1
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

  // 配图的基地址：webServer 挂载时（registerPanelRoute）填进来，
  // go_draw_diagram 在**执行时**读取它 —— 注册顺序与挂载时机因此不敏感。
  const diagram = createDiagramBase()
  registerGoTools(ctx, cfg, new ReviewCache(), { diagram })
  registerPanelRoute(ctx, cfg, diagram)
}
