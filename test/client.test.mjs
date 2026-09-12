// test/client.test.mjs — 客户端 half 测试（React/插槽桩 + 服务端路由）
//
// 客户端 half 已从「自绘 DOM 浮动面板」改为「注册进 composer dock 的插槽组件」，
// 因此这里不再断言 DOM 结构，而是断言：
//   1. 装载协议：ModuleLoader id 与 package.json name 一致，且不声明硬注入；
//   2. 面板注册到 conversation.composer.dock，展开后渲染问题手列表；
//   3. 点某一行调用 inputActions.setDraft（真插入输入框，而非剪贴板）；
//   4. 服务端 /go-sensei/review 路由：正常返回、相对路径、缺参/缺失/目录拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

// 仓库自带 engine/ 目录（开箱即用的 KataGo）；要测「无引擎」路径必须显式避开它。
const NO_ENGINE_CFG = { kataGoPath: '', engineDir: join(here, 'no-such-engine') }

// ---------------------------------------------------------------------------
// React / ModuleLoader / slots 桩
// ---------------------------------------------------------------------------

function makeReactStub() {
  const hooks = []
  let cursor = 0
  return {
    hooks,
    reset() { cursor = 0 },
    api: {
      createElement(type, props) {
        const children = Array.prototype.slice.call(arguments, 2)
        return { __el: true, type, props: props || {}, children }
      },
      useState(initial) {
        const index = cursor++
        if (hooks.length <= index) hooks.push(initial)
        const set = (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }
        return [hooks[index], set]
      },
      useEffect() {},
    },
  }
}

function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (node.__el) {
    out.push(node)
    for (const child of node.children) walk(child, out)
  }
  return out
}

function texts(nodes) {
  const out = []
  for (const node of nodes) {
    for (const child of node.children) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child))
    }
  }
  return out
}

/** 装载 client.js，返回 entry 与测试用的桩对象。 */
function loadClient({ withReact = true } = {}) {
  const react = makeReactStub()
  const registered = []
  const injected = []
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: { load(entry) { loaded.push(entry) } },
  }
  const slots = {
    inject(target, callback) { injected.push(target); return callback() },
    register(options, component) { registered.push({ options, component }); return () => {} },
  }
  const ctx = { get: (name) => (name === 'slots' ? slots : undefined) }
  const requireStub = (name) => {
    if (name === 'react' && withReact) return react.api
    throw new Error('module not found: ' + name)
  }
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // 以函数体执行，模拟宿主 ModuleLoader 调用工厂
  const fn = new Function('window', 'document', 'navigator', source)
  fn(globalThis.window, undefined, undefined)
  const entry = loaded[0]
  const plugin = entry.factory(requireStub)
  plugin.apply(ctx)
  return { entry, plugin, registered, injected, react }
}

// ---------------------------------------------------------------------------

test('client: ModuleLoader id 与 package.json name 完全一致', () => {
  const { entry } = loadClient()
  assert.ok(entry, '必须调用 window.__ModuleLoader__.load')
  assert.equal(entry.id, pkg.name)
  assert.equal(typeof entry.factory, 'function')
})

test('client: 工厂返回 Cordis 插件形状（name/apply，且不声明硬注入）', () => {
  const { plugin } = loadClient()
  assert.equal(plugin.name, pkg.name)
  assert.equal(typeof plugin.apply, 'function')
  // 软依赖：缺 slots/react 时静默降级，故不做硬注入，否则整包会永久 pending
  assert.deepEqual(plugin.inject, [])
})

test('client: 面板注册到 conversation.composer.dock（该插槽才有 inputActions）', () => {
  const { registered, injected } = loadClient()
  assert.deepEqual(injected, ['conversation.composer.dock'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'conversation.composer.dock')
  assert.equal(registered[0].options.id, 'go-sensei-panel')
  assert.equal(typeof registered[0].component, 'function')
})

test('client: React 缺席时静默跳过注册（不抛错）', () => {
  assert.doesNotThrow(() => {
    const { registered } = loadClient({ withReact: false })
    assert.equal(registered.length, 0)
  })
})

test('client: 折叠态只渲染标题与展开按钮', () => {
  const { registered, react } = loadClient()
  react.reset()
  const tree = registered[0].component({ inputActions: { setDraft() {} } })
  const all = texts(walk(tree)).join('|')
  assert.ok(all.includes('DeepGo Sensei'), `实际渲染文本：${all}`)
  assert.ok(all.includes('展开'))
  assert.ok(!all.includes('读取问题手'), '折叠时不应渲染主体')
})

test('client: 展开后渲染路径输入框与读取按钮', () => {
  const { registered, react } = loadClient()
  react.reset()
  let tree = registered[0].component({ inputActions: { setDraft() {} } })
  const toggle = walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开'))
  assert.ok(toggle, '存在展开按钮')
  toggle.props.onClick()
  react.reset()
  tree = registered[0].component({ inputActions: { setDraft() {} } })
  const nodes = walk(tree)
  const all = texts(nodes).join('|')
  assert.ok(all.includes('读取问题手'), `实际渲染文本：${all}`)
  const input = nodes.find((n) => n.type === 'input')
  assert.ok(input, '存在路径输入框')
  assert.ok(String(input.props.placeholder).includes('SGF'))
})

test('client: 未载入棋谱时也给出棋盘入口与跟随开关（否则跟随永远带不进棋谱）', () => {
  const { registered, react } = loadClient()
  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)

  let all = texts(walk(tree)).join('|')
  assert.ok(all.includes('棋盘 ▸'), `应有棋盘入口：${all}`)
  assert.ok(all.includes('未载入棋谱'), '应说明还没载入棋谱')
  assert.ok(all.includes('跟随讲解 ✓'), '跟随开关在没有棋谱时也要能按')

  // 展开棋盘：给出「跟随会自动带出棋谱」的说明，而不是一片空白
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('棋盘 ▸')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  all = texts(walk(tree)).join('|')
  assert.ok(all.includes('跟随讲解已开'), `展开后应给出说明：${all}`)
  assert.equal(walk(tree).find((n) => n.type === 'svg'), undefined, '没有棋谱时不画棋盘')
})

test('client: 手动读取会「认掉」当前指针，旧讲解不再抢走用户选的棋谱', async () => {
  const { registered, react, plugin } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 106, variations: 2, candidates: [], board: null } }),
  })
  // 模拟「已经见过 seq=4 的指针（例如别的会话留下的）但还没应用」
  plugin.__internals.focusPointer.seen = 4
  plugin.__internals.focusPointer.seq = 0

  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(plugin.__internals.focusPointer.seq, 4, '手动读取后应把已见过的指针认成已应用')
})

test('client: 点问题手一行 → inputActions.setDraft（真插入，非剪贴板）', async () => {
  const { registered, react } = loadClient()
  const drafts = []
  const actions = {
    setDraft: (text) => drafts.push(text),
    addAttachments: () => false,
    removeAttachment() {},
    pruneAttachments() {},
    submit() {},
  }

  const gamePath = fixture('real-analysis.sgf')
  const candidates = [
    { moveNumber: 21, color: 'B', coord: 'ff', coordLabel: 'F14', label: '大恶手', winrateLoss: 98.8, scoreLoss: 46.2, pv: [{ label: 'F16', winratePct: 98.9 }] },
    { moveNumber: 23, color: 'B', coord: 'fe', coordLabel: 'F15', label: '大恶手', winrateLoss: 81.3, scoreLoss: 22.1, pv: [{ label: 'F16', winratePct: 99.6 }] },
  ]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 106, variations: 2, candidates },
    }),
  })

  const props = { inputActions: actions, useSession: () => ({ header: { cwd: 'C:/dsh/WeiQi' } }) }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)

  const nodes = walk(tree)
  const items = nodes.filter((n) => n.type === 'button' && n.props.className === 'dgs-item')
  assert.equal(items.length, 2, `应渲染 2 个问题手行，实际 ${items.length}`)
  const itemText = items.map((n) => texts(walk(n)).join(' ')).join(' || ')
  assert.ok(itemText.includes('第 21 手') && itemText.includes('F14') && itemText.includes('大恶手'), itemText)
  assert.ok(itemText.includes('98.8'), '应显示胜率差')

  items[0].props.onClick()
  assert.equal(drafts.length, 1, 'setDraft 应被调用一次')
  assert.ok(drafts[0].includes('第 21 手'), drafts[0])
  assert.ok(drafts[0].includes('F14'))
  assert.ok(drafts[0].includes('F16'), '含 AI 推荐')
  assert.ok(drafts[0].includes(gamePath), '含棋谱路径')
})

// ---------------------------------------------------------------------------
// 服务端路由：/go-sensei/review
// ---------------------------------------------------------------------------

/** 最小 fs 桩：够 registerPanelRoute 用（resolve/stat/readBytes）。 */
function makeFsStub() {
  return {
    async resolve(p, opts = {}) {
      const abs = resolve(opts.cwd ?? process.cwd(), p)
      return { displayPath: abs, targetKey: abs }
    },
    async stat(target) {
      try {
        const { statSync } = await import('node:fs')
        const info = statSync(target.displayPath)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch { return undefined }
    },
    async readBytes(target) {
      const { readFileSync } = await import('node:fs')
      return readFileSync(target.displayPath)
    },
  }
}

/** 路由测试用的完整 ctx 桩：apply() 需要 systemPrompt/tools/fs/on，路由需要 webServer。 */
function makeRouteCtx({ withWebServer = true } = {}) {
  const routes = []
  const registered = new Map()
  const sections = []
  const listeners = new Map()
  return {
    routes,
    registered,
    sections,
    listeners,
    fs: makeFsStub(),
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 0,
    },
    emit() {},
    // tools/result 观察者：记录工具成功的工作区根（供相对路径解析）
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer' && withWebServer) {
        return { register: (route) => { routes.push(route); return () => {} } }
      }
      return undefined
    },
  }
}

/** 调一次路由处理器，收集响应。 */
async function callRoute(route, url) {
  let body = ''
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { body = chunk },
  }
  await route.handler({ url }, res)
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, body: parsed }
}

test('路由: 正常读取真实棋谱并返回问题手（含裁剪字段）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  assert.ok(route, '路由应被注册')
  assert.equal(route.kind, 'exact')

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.data.moveCount, 106)
  assert.equal(r.body.data.mode, 'analysis')
  assert.equal(r.body.data.level, '18K')
  assert.ok(r.body.data.candidates.length > 0)
  const first = r.body.data.candidates[0]
  for (const key of ['moveNumber', 'color', 'coord', 'coordLabel', 'label', 'winrateLoss', 'scoreLoss', 'pv']) {
    assert.ok(Object.hasOwn(first, key), `候选应含 ${key}`)
  }
  assert.ok(first.pv.length <= 3, 'PV 应裁剪到 ≤3')
})

test('路由: cwd 参数控制相对路径解析基准', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf')
    + '&cwd=' + encodeURIComponent(join(here, 'fixtures')))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.moveCount, 106)
})

test('路由: 缺 path 参数 → 400', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review')
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
})

test('路由: 文件不存在 → 404', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('definitely-missing.sgf'))
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
})

test('路由: 目录而非文件 → 400', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(here))
  assert.equal(r.status, 400)
})

test('路由: webServer 缺席时不注册也不抛错', () => {
  const ctx = makeRouteCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx, Config(NO_ENGINE_CFG)))
  assert.equal(ctx.routes.length, 0, '无 webServer 时不应注册路由')
  // 无引擎（engineDir 指到不存在的目录）：5 个复盘工具 + 始终注册的 go_engine_info
  assert.equal(ctx.registered.size, 6, '工具仍应照常注册')
})

// ---------------------------------------------------------------------------
// 工作区根的发现：浏览器拿不到会话 cwd（客户端 SessionSnapshot 里没有该字段），
// 因此把模型调用 go_* 工具时的 exec.agent.session.header.cwd 记下来，
// 作为面板相对路径的解析基准。
// ---------------------------------------------------------------------------

test('路由: 用 tools/result 记下的工作区根解析相对路径', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  // 记根之前：相对路径解析不到
  const before = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(before.status, 404, '未记根时相对路径应 404')

  // 模拟模型调用 go_parse_sgf 成功：观察者记住会话 cwd
  const listener = ctx.listeners.get('tools/result')
  assert.equal(typeof listener, 'function', '应订阅 tools/result')
  listener({ name: 'go_parse_sgf', agent: { session: { header: { cwd: join(here, 'fixtures') } } } })

  // 记根之后：同一相对路径命中
  const after = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(after.status, 200)
  assert.equal(after.body.data.moveCount, 106)

  // /go-sensei/roots 暴露已知根，便于面板展示
  const rootsRoute = ctx.routes.find((r) => r.path === '/go-sensei/roots')
  assert.ok(rootsRoute, '应注册 /go-sensei/roots')
  let body = ''
  await rootsRoute.handler({ url: '/go-sensei/roots' }, { setHeader() {}, end(c) { body = c } })
  const parsed = JSON.parse(body)
  assert.ok(parsed.roots.includes(join(here, 'fixtures')), JSON.stringify(parsed))
})

test('路由: 非 go_ 工具的 tools/result 不会被记根', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  listener({ name: 'bash', agent: { session: { header: { cwd: join(here, 'fixtures') } } } })
  const route = ctx.routes.find((r) => r.path === '/go-sensei/roots')
  let body = ''
  await route.handler({ url: '/go-sensei/roots' }, { setHeader() {}, end(c) { body = c } })
  assert.deepEqual(JSON.parse(body).roots, [])
})

test('路由: 观察者抛错不影响工具链路', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  // 形状异常（没有 agent）不应抛错
  assert.doesNotThrow(() => listener({ name: 'go_parse_sgf' }))
  assert.doesNotThrow(() => listener(undefined))
})

test('路由: 已知根之下按 basename 有界发现（用户只写 game.sgf 也能命中）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))

  // 记下一个根
  const fixturesDir = join(here, 'fixtures')
  ctx.listeners.get('tools/result')({
    name: 'go_review_moves',
    agent: { session: { header: { cwd: fixturesDir } } },
  })

  // 给 fs 桩补 listDir：模拟根目录下有一个子目录，棋谱在子目录里
  const { readdirSync, statSync } = await import('node:fs')
  ctx.fs.listDir = async (target) => {
    const dir = target.displayPath
    return readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const child = join(dir, entry.name)
      return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: { displayPath: child, targetKey: child } }
    })
  }
  ctx.fs.stat = async (target) => {
    try {
      const info = statSync(target.displayPath)
      return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
    } catch { return undefined }
  }

  // 纯文件名 + 深度 1 的子目录：应被发现
  const r = await callRoute(ctx.routes.find((x) => x.path === '/go-sensei/review'),
    '/go-sensei/review?path=' + encodeURIComponent('real-analysis.sgf'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.moveCount, 106)
})

// ---------------------------------------------------------------------------
// 内置棋盘：Host 数据（board 字段 / 讲解指针）、Client 渲染与规则
// ---------------------------------------------------------------------------

/** 数一数渲染出的棋子（棋子的 className 标记了黑白）。 */
function stoneCounts(tree) {
  const nodes = walk(tree)
  const pick = (mark) => nodes.filter((n) => n.type === 'circle'
    && String(n.props.className || '').includes(mark)).length
  return { black: pick('dgs-stone-b'), white: pick('dgs-stone-w') }
}

/** 5 手的小局面：最后一手提掉中间的白子，用来验证"棋盘要按规则画"。 */
const CAPTURE_BOARD = {
  size: 19,
  komi: 7.5,
  handicap: 0,
  moves: [
    { c: 'B', x: 2, y: 3 },
    { c: 'W', x: 3, y: 3 },
    { c: 'B', x: 4, y: 3 },
    { c: 'B', x: 3, y: 2 },
    { c: 'B', x: 3, y: 4 },
  ],
  setup: { black: [], white: [] },
}

test('client: 棋盘纯规则（落子/提子/摆子/坐标换算）', () => {
  const { plugin } = loadClient()
  const { boardAt, boardLabel, parsePointLabel } = plugin.__internals
  assert.equal(typeof boardAt, 'function', '__internals 应暴露棋盘规则供单测')

  assert.equal(boardAt(CAPTURE_BOARD, 4)[3 * 19 + 3], 2, '第 4 手后白子还在')
  assert.equal(boardAt(CAPTURE_BOARD, 5)[3 * 19 + 3], 0, '第 5 手应提掉白子')
  assert.equal(boardAt(CAPTURE_BOARD, 0).filter((v) => v !== 0).length, 0, '开局空盘')

  const handicap = { size: 9, moves: [], setup: { black: [[2, 2], [6, 6]], white: [[4, 4]] } }
  const grid = boardAt(handicap, 0)
  assert.equal(grid[2 * 9 + 2], 1)
  assert.equal(grid[6 * 9 + 6], 1)
  assert.equal(grid[4 * 9 + 4], 2)

  assert.equal(boardLabel(15, 3, 19), 'Q16')
  assert.deepEqual(parsePointLabel('Q16', 19), { x: 15, y: 3 })
  assert.equal(parsePointLabel('I5', 19), null, '字母 I 不是合法列')
  assert.equal(parsePointLabel('K5', 9), null, '9 路只有 A..J，K 列越界')
  assert.deepEqual(parsePointLabel('J9', 9), { x: 8, y: 0 }, '9 路的角点仍要认')
  assert.equal(parsePointLabel('Q20', 19), null, '行号越界')
})

test('client: 路径同一性判断（同名不同盘的棋不能被当成同一盘）', () => {
  const { plugin } = loadClient()
  const { sameFile } = plugin.__internals
  assert.equal(typeof sameFile, 'function', '__internals 应暴露 sameFile')

  assert.equal(sameFile('C:/a/b/game.sgf', 'C:\\a\\b\\game.sgf'), true, '分隔符与大小写无关')
  assert.equal(sameFile('C:/a/b/game.sgf', 'game.sgf'), true, '一方只有文件名时按文件名比')
  assert.equal(sameFile('C:/x/review-check/_accept/game.sgf', 'review-check/_accept/game.sgf'), true,
    '相对路径是绝对路径的后缀')
  assert.equal(sameFile('C:/a/game.sgf', 'D:/b/game.sgf'), false, '同名但不同目录不是同一盘')
  assert.equal(sameFile('', 'game.sgf'), false, '空路径不匹配任何东西')
})

test('client: 棋盘渲染对畸形候选数据不抛错（首选标签解析不出来时）', () => {
  const { plugin, react } = loadClient()
  const { renderBoard } = plugin.__internals
  assert.equal(typeof renderBoard, 'function')

  react.reset()
  // 'pass' / 空标签都解析不出坐标：整块面板不能因此崩掉
  const tree = renderBoard({
    board: CAPTURE_BOARD, upto: 5, problem: null, pv: [null, null], hintLabel: 'pass', onPick: null,
  })
  const nodes = walk(tree)
  assert.ok(nodes.some((n) => n.type === 'svg'), '仍应画出棋盘')
  assert.ok(!nodes.some((n) => n.type === 'rect' && n.props.fill === '#ffc800'), '解析不出坐标时不画信息条')
  assert.ok(!nodes.some((n) => n.type === 'circle' && n.props.stroke === '#0000ff'), '也不画首选蓝圈')
})

test('client: 变化图落在实战已占的点上时不画蓝点（免得像把子叠在子上）', () => {
  const { plugin, react } = loadClient()
  const { renderBoard } = plugin.__internals
  const board = {
    size: 9,
    moves: [{ c: 'B', x: 2, y: 2 }],
    setup: { black: [], white: [] },
  }
  react.reset()
  // pv[1] 正落在第 1 手黑子上，pv[2] 是空点
  const tree = renderBoard({
    board, upto: 1, problem: null, hintLabel: '',
    pv: [{ x: 4, y: 4 }, { x: 2, y: 2 }, { x: 5, y: 5 }], onPick: null,
  })
  const dots = walk(tree).filter((n) => n.type === 'circle' && n.props.fill === '#1668ff')
  assert.equal(dots.length, 1, '只画落在空点上的那一手')
  assert.equal(dots[0].props.cx, 8 + 5 * (84 / 8), '留下的是 pv[2]（序号 3）')
})

test('client: 面板如实显示补算状态（补了多少手 / 失败原因）', async () => {
  const { registered, react } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  const board = { size: 19, moves: [{ c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }], setup: { black: [], white: [] } }

  const render = async (data) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data }) })
    const props = { inputActions: { setDraft() {} } }
    react.reset()
    let tree = registered[0].component(props)
    const btn = (label) => walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    if (btn('展开') !== undefined) { btn('展开').props.onClick(); react.reset(); tree = registered[0].component(props) }
    walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
    react.reset()
    tree = registered[0].component(props)
    walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    react.reset()
    return texts(walk(registered[0].component(props))).join('|')
  }

  // 补算成功：手数与耗时都要露出来
  const ok = await render({
    path: gamePath, mode: 'analysis', level: '18K', moveCount: 2, variations: 0, candidates: [],
    board, autoEngine: { from: 1, to: 2, moves: 113, seconds: 34.5, engine: 'KataGo' },
  })
  assert.ok(ok.includes('引擎补算 113 手'), ok)
  assert.ok(ok.includes('34.5 秒'), ok)

  // 补算失败：失败原因要露出来，且"没东西可讲"要说清是补算没成功
  const failed = await render({
    path: gamePath, mode: 'theory', level: '18K', moveCount: 2, variations: 0, candidates: [],
    board, autoEngine: { failed: 'subprocess 服务不可用，无法自起 KataGo 补算' },
  })
  assert.ok(failed.includes('补算未成功'), failed)
  assert.ok(failed.includes('subprocess 服务不可用'), failed)
  assert.ok(failed.includes('棋谱没有可用的分析数据，补算也没成功'), failed)

  // 没有补算记录（引擎不可用）：说明这一档只讲棋理
  const theory = await render({
    path: gamePath, mode: 'theory', level: '18K', moveCount: 2, variations: 0, candidates: [], board,
  })
  assert.ok(theory.includes('这一档只能讲棋理'), theory)
})

test('路由: /go-sensei/review 一并返回棋盘数据（尺寸/手顺/摆子）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const route = ctx.routes.find((r) => r.path === '/go-sensei/review')

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('synthetic-analysis.sgf')))
  assert.equal(r.status, 200)
  const board = r.body.data.board
  assert.ok(board, '应返回 board 字段（客户端画盘只靠它）')
  assert.equal(board.size, 19)
  assert.equal(board.moves.length, r.body.data.moveCount)
  // 首手 B:pd —— SGF 坐标 pd 对应 x=15,y=3，客户端据此落子
  assert.deepEqual(board.moves[0], { c: 'B', x: 15, y: 3 })
  assert.deepEqual(board.setup, { black: [], white: [] })

  const real = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('real-analysis.sgf')))
  assert.equal(real.status, 200)
  assert.equal(real.body.data.board.moves.length, 106, '手顺长度必须与手数一致')
  assert.ok(real.body.data.players, '面板表头要显示棋手名')
})

test('路由: /go-sensei/focus 跟随讲解（工具调用 -> 局面指针）', async () => {
  const ctx = makeRouteCtx()
  apply(ctx, Config(NO_ENGINE_CFG))
  const listener = ctx.listeners.get('tools/result')
  const focusRoute = ctx.routes.find((r) => r.path === '/go-sensei/focus')
  assert.ok(focusRoute, '应注册 /go-sensei/focus')

  let r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.ok, true)
  assert.equal(r.body.focus, null, '还没有讲解时指针为空')

  const at = (name, args, extra) => listener({ name, arguments: args, agent: { session: { header: { cwd: 'C:/dsh/WeiQi' } } } }, extra)

  at('go_position_context', { path: 'review-check/_accept/game.sgf', moveNumber: 21 })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'game.sgf')
  assert.equal(r.body.focus.moveNumber, 21)
  assert.equal(r.body.focus.cwd, 'C:/dsh/WeiQi')
  assert.equal(r.body.focus.kind, 'context')
  assert.equal(r.body.focus.seq, 1)

  // 失败的调用不改变讲解位置（模型试错路径很常见）
  at('go_position_context', { path: 'nope.sgf', moveNumber: 99 }, { isError: true })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.moveNumber, 21)
  assert.equal(r.body.focus.seq, 1)

  // 回写注释：正在讲的位置 = 第一条注释的手数
  at('go_write_review', { path: 'game.sgf', entries: [{ moveNumber: 33, comment: 'x' }, { moveNumber: 47, comment: 'y' }] })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.moveNumber, 33)
  assert.equal(r.body.focus.kind, 'write')
  assert.equal(r.body.focus.seq, 2)

  // 只读棋谱：知道在讲哪一盘，但不知道第几手
  at('go_parse_sgf', { path: 'other.sgf' })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'other.sgf')
  assert.equal(Object.hasOwn(r.body.focus, 'moveNumber'), false)

  // 非 go_ 工具不碰指针
  listener({ name: 'bash', arguments: { path: 'x.sgf', moveNumber: 1 }, agent: { session: { header: { cwd: 'C:/dsh/WeiQi' } } } })
  r = await callRoute(focusRoute, '/go-sensei/focus')
  assert.equal(r.body.focus.name, 'other.sgf')
})

test('client: 载入后停在最严重的问题手，并把所有问题手点在盘上', async () => {
  const { registered, react } = loadClient()
  const gamePath = fixture('real-analysis.sgf')
  const BOARD8 = {
    size: 19,
    moves: [
      { c: 'B', x: 3, y: 3 }, { c: 'W', x: 15, y: 15 }, { c: 'B', x: 4, y: 4 },
      { c: 'W', x: 15, y: 3 }, { c: 'B', x: 3, y: 15 }, { c: 'W', x: 9, y: 9 },
      { c: 'B', x: 2, y: 2 }, { c: 'W', x: 16, y: 16 },
    ],
    setup: { black: [], white: [] },
  }
  // 宿主按严重度排序：[0] = 最严重（第 3 手），第 6 手是次要的一处
  const candidates = [
    { moveNumber: 3, color: 'B', coord: 'dd', coordLabel: 'D16', label: '大恶手', labelKey: 'blunder', winrateLoss: 25, scoreLoss: 12, pv: [{ label: 'Q16', winratePct: 50 }] },
    { moveNumber: 6, color: 'W', coord: 'jj', coordLabel: 'K10', label: '失误', labelKey: 'mistake', winrateLoss: 9, scoreLoss: 5, pv: [] },
  ]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: { path: gamePath, mode: 'analysis', level: '18K', moveCount: 8, variations: 0, candidates, board: BOARD8 },
    }),
  })

  const props = { inputActions: { setDraft() {} } }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)
  // 展开棋盘（默认是收起的）
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('棋盘 ▸')).props.onClick()
  react.reset()
  tree = registered[0].component(props)

  // 自动停在第 3 手（最严重的那一处），而不是末手
  assert.ok(texts(walk(tree)).join('|').includes('第 3/8 手'), '载入后应停在最严重的问题手')
  const nodes = walk(tree)
  const dotOf = (color) => nodes.filter((n) => n.type === 'circle' && n.props.fill === color
    && Math.abs(Number(n.props.r) - 0.16 * (84 / 18)) < 0.001)
  assert.equal(dotOf('#9b1996').length, 1, '大恶手应有一个紫点')
  assert.equal(dotOf('#d01013').length, 1, '失误应有一个红点')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#9b1996'), '当前这一手还要有大圈')

  // 恶点跳转：下一个 → 下一个（到头绕回第一个）→ 上一个（到头绕回最后一个）。
  // 这一步要放在拨回开局之前（起点是自动落位的第 3 手）。
  const clickBtn = (label) => {
    const button = walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    assert.ok(button, `找不到按钮 ${label}`)
    assert.ok(!button.props.disabled, `${label} 不应被禁用（本局有问题手）`)
    button.props.onClick()
    react.reset()
    tree = registered[0].component(props)
    return texts(walk(tree)).join('|')
  }
  assert.ok(clickBtn('恶点▶').includes('第 6/8 手'), '「恶点▶」应跳到下一处（第 6 手）')
  assert.ok(clickBtn('恶点▶').includes('第 3/8 手'), '最后一处再点应绕回第一处（第 3 手）')
  assert.ok(clickBtn('◀恶点').includes('第 6/8 手'), '第一处再往回点应绕到最后一处（第 6 手）')
  // 回到自动落位的那一手，继续验证色点
  assert.ok(clickBtn('恶点▶').includes('第 3/8 手'), '再点一次回到第 3 手')

  // 把棋盘拨回开局：小色点仍在（停在哪一手都看得见），说明行讲清它们是什么
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('⏮')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  const nodes2 = walk(tree)
  assert.equal(nodes2.filter((n) => n.type === 'circle'
    && ['#9b1996', '#d01013'].includes(n.props.fill)).length, 2, '离开问题手后小色点仍应留在盘上')
  assert.ok(!nodes2.some((n) => n.type === 'circle' && n.props.stroke === '#9b1996'), '大圈只套在当前这一手上')
  assert.ok(texts(nodes2).join('|').includes('盘上色点＝问题手'), '应说明盘上色点的含义')
})

test('client: 棋盘可收起；点问题手自动展开并跳到那一手（含红圈/绿圈）', async () => {
  const { registered, react } = loadClient()
  const drafts = []
  const actions = {
    setDraft: (text) => drafts.push(text),
    addAttachments: () => false,
    removeAttachment() {},
    pruneAttachments() {},
    submit() {},
  }
  const gamePath = fixture('real-analysis.sgf')
  const candidates = [{
    moveNumber: 3,
    color: 'B',
    coord: 'ed',
    coordLabel: 'E16',
    label: '失误',
    labelKey: 'mistake',
    winrateLoss: 12.3,
    scoreLoss: 4.5,
    pv: [{ label: 'Q16', winratePct: 55.5 }, { label: 'D4', winratePct: 48.2 }],
  }]
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/go-sensei/focus')
      ? { ok: true, focus: null }
      : {
          ok: true,
          data: {
            path: gamePath, mode: 'analysis', level: '18K', moveCount: 5, variations: 0,
            candidates, board: CAPTURE_BOARD,
            players: { black: '甲', white: '乙' },
          },
        }),
  })

  const props = { inputActions: actions, useSession: () => ({ header: { cwd: 'C:/dsh/WeiQi' } }) }
  react.reset()
  let tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('展开')).props.onClick()
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'input').props.onChange({ target: { value: gamePath } })
  react.reset()
  tree = registered[0].component(props)
  walk(tree).find((n) => n.type === 'button' && texts([n]).includes('读取问题手')).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  react.reset()
  tree = registered[0].component(props)

  // 收起态：只有表头，没有 svg；表头给出当前手
  assert.ok(texts(walk(tree)).join('|').includes('棋盘 ▸'), '应有收起态的棋盘入口')
  assert.equal(walk(tree).find((n) => n.type === 'svg'), undefined, '收起时不应渲染棋盘')

  // 点问题手：自动展开 + 跳到第 3 手 + 插入追问语
  const items = walk(tree).filter((n) => n.type === 'button' && n.props.className === 'dgs-item')
  assert.equal(items.length, 1)
  items[0].props.onClick()
  assert.ok(drafts[0].includes('第 3 手'), drafts[0])
  react.reset()
  tree = registered[0].component(props)
  const svg = walk(tree).find((n) => n.type === 'svg')
  assert.ok(svg, '点问题手后棋盘应自动展开')
  assert.equal(svg.props['data-dgs-board'], '19')
  assert.equal(stoneCounts(tree).black, 2, '第 3 手时盘上 2 颗黑子')
  assert.equal(stoneCounts(tree).white, 1)
  const nodes = walk(tree)
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.stroke === '#d01013'),
    '问题手圆圈按严重度取色（失误 = Lizzieyzy 的 (208,16,19)）')
  const bestRing = nodes.find((n) => n.type === 'circle' && n.props.stroke === '#0000ff')
  assert.ok(bestRing, 'AI 首选应有蓝圈（Lizzieyzy showBlueRing）')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.fill === 'rgba(0, 255, 255, 0.5)'),
    'AI 首选应是青色实心圆')
  // Q16 -> x=15,y=3 -> pos = 8 + 15*(84/18) = 78, 8 + 3*(84/18) = 22
  assert.ok(Math.abs(bestRing.props.cx - 78) < 0.01 && Math.abs(bestRing.props.cy - 22) < 0.01,
    `蓝圈应在 Q16（实际 ${bestRing.props.cx},${bestRing.props.cy}）`)
  assert.ok(nodes.some((n) => n.type === 'rect' && n.props.fill === '#ffc800'), '首选点胜率用橙底信息条')
  assert.ok(nodes.some((n) => n.type === 'circle' && n.props.fill === '#1668ff'), '变化图第 2 手应有蓝点')
  const text = texts(nodes).join('|')
  assert.ok(text.includes('AI 首选 Q16'), text)
  assert.ok(text.includes('○ 实战 3 手 E16'), text)
  assert.ok(text.includes('D4'), '说明行应给出变化图后续')

  // 步进：⏮ 回开局 → ▶ 一手；⏭ 回末手（提子生效，白子消失）
  const click = (label) => {
    const button = walk(tree).find((n) => n.type === 'button' && texts([n]).includes(label))
    assert.ok(button, `找不到按钮 ${label}`)
    button.props.onClick()
    react.reset()
    tree = registered[0].component(props)
  }
  click('⏮')
  assert.equal(stoneCounts(tree).black + stoneCounts(tree).white, 0, '开局空盘')
  assert.ok(texts(walk(tree)).join('|').includes('开局'), '表头应显示开局')
  click('▶')
  assert.equal(stoneCounts(tree).black, 1)
  click('⏭')
  const end = stoneCounts(tree)
  assert.equal(end.black, 4, '末手前黑 4 子')
  assert.equal(end.white, 0, '末手提掉白子')

  // 再点一次「棋盘 ▾」应收起（可收起）
  click('棋盘 ▾')
  assert.equal(walk(tree).find((n) => n.type === 'svg'), undefined, '收起后棋盘应消失')
})
