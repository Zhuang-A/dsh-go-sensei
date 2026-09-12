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

  const gamePath = fixture('lizzieyzy-real.sgf')
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

  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent(fixture('lizzieyzy-real.sgf')))
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
  const r = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('lizzieyzy-real.sgf')
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
  const before = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('lizzieyzy-real.sgf'))
  assert.equal(before.status, 404, '未记根时相对路径应 404')

  // 模拟模型调用 go_parse_sgf 成功：观察者记住会话 cwd
  const listener = ctx.listeners.get('tools/result')
  assert.equal(typeof listener, 'function', '应订阅 tools/result')
  listener({ name: 'go_parse_sgf', agent: { session: { header: { cwd: join(here, 'fixtures') } } } })

  // 记根之后：同一相对路径命中
  const after = await callRoute(route, '/go-sensei/review?path=' + encodeURIComponent('lizzieyzy-real.sgf'))
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
    '/go-sensei/review?path=' + encodeURIComponent('lizzieyzy-real.sgf'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.moveCount, 106)
})
