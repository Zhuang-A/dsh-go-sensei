// client.js — DeepGo Sensei 浏览器 half（Client bundle）
//
// 装载协议：window.__ModuleLoader__.load({ id, factory })，id 必须与
// package.json 的 name 完全一致。工厂收一个 require（宿主平台模块表），
// 可 require('react') —— React 来自宿主共享的表，手写 CJS 外壳、零构建。
//
// 职责（Phase 4）：
//   1. 在 composer dock 注册「Sensei 复盘」入口：展开后输入 SGF 路径 →
//      从 Host 路由 /go-sensei/review 取问题手列表（手数/颜色/坐标/徽标/
//      胜率差/目差/AI 首选）并渲染；
//   2. 点任意一行 → 用插槽 props 的 inputActions.setDraft() 把追问语
//      **真正插入输入框**（不是剪贴板）。
//
// 为什么数据要问 Host：Client 拿不到工具的 execute，也不能直接读盘；Host 的
// index.mjs 拥有 ctx.fs 与 reviewGame，所以由它读盘算好、回 JSON。
//
// 为什么注册在 composer dock 而不是 shell.overlay：只有 composer 系列插槽的
// 标准 props 提供 inputActions（shell.overlay 只有 useSessions/usePanelInfo 等），
// 而「点击插入输入框」必须用它。
//
// 兜底：React 或 slots 缺席时不抛错、静默只装顶部打点，不影响插件其余部分。

window.__ModuleLoader__.load({
  id: 'dsh-go-sensei',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var React = null
    try {
      // 宿主平台模块表注入的 require；极旧宿主或不传 require 时降级为「无面板」
      React = typeof require === 'function' ? require('react') : null
    } catch (error) {
      React = null
    }

    var STYLE_ID = 'dsh-go-sensei-style'
    var CSS = [
      '[data-dgs] { border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #23242a);',
      '  color: var(--dsw-alias-label-primary, #e8eaf0); font-size: 12px;',
      '  line-height: 1.5; margin: 6px auto 0; max-width: 860px; padding: 8px 10px; }',
      '[data-dgs] .dgs-head { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-title { font-weight: 600; }',
      '[data-dgs] .dgs-sub { color: var(--dsw-alias-label-secondary, #9aa4b2); font-size: 11px; }',
      '[data-dgs] .dgs-spacer { flex: 1; }',
      '[data-dgs] button { cursor: pointer; font: inherit; color: inherit;',
      '  background: var(--dsw-alias-bg-layer-2, #2a2b31);',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  border-radius: 6px; padding: 3px 8px; }',
      '[data-dgs] button:hover { border-color: var(--dsw-alias-brand-primary, #6b8afd); }',
      '[data-dgs] button[disabled] { opacity: .55; cursor: default; }',
      '[data-dgs] input { flex: 1; min-width: 0; padding: 4px 7px; font: inherit; border-radius: 6px;',
      '  color: var(--dsw-alias-label-primary, #e8eaf0); background: var(--dsw-alias-bg-layer-2, #2a2b31);',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); }',
      '[data-dgs] .dgs-row { display: flex; gap: 6px; margin-top: 6px; }',
      '[data-dgs] .dgs-err { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; margin-top: 6px; }',
      '[data-dgs] .dgs-ok { color: var(--dsw-alias-state-success-primary, #3fb950); font-size: 11px; margin-top: 6px; }',
      '[data-dgs] .dgs-list { margin-top: 8px; max-height: 300px; overflow-y: auto;',
      '  display: flex; flex-direction: column; gap: 4px; }',
      '[data-dgs] .dgs-item { width: 100%; text-align: left; padding: 5px 8px; }',
      '[data-dgs] .dgs-l1 { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-mv { font-weight: 600; }',
      '[data-dgs] .dgs-coord { color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      '[data-dgs] .dgs-badge { margin-left: auto; font-size: 10px; padding: 0 6px;',
      '  border-radius: 999px; border: 1px solid currentColor; }',
      '[data-dgs] .dgs-l2 { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); }',
      // ── 内置棋盘（可收起）──────────────────────────────────────────────
      '[data-dgs] .dgs-boardwrap { border-top: 1px dashed var(--dsw-alias-border-l1, rgba(255,255,255,.12));',
      '  margin-top: 8px; padding-top: 6px; }',
      '[data-dgs] .dgs-boardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '[data-dgs] .dgs-boardhead .dgs-sub { flex: 1; min-width: 0; }',
      '[data-dgs] .dgs-split { display: flex; gap: 12px; align-items: flex-start; margin-top: 6px; }',
      '[data-dgs] .dgs-col-board { flex: 0 0 auto; width: 300px; max-width: 46%; }',
      '[data-dgs] .dgs-col-list { flex: 1; min-width: 0; }',
      '[data-dgs] .dgs-board { display: block; width: 100%; height: auto; border-radius: 6px; }',
      '[data-dgs] .dgs-ctl { display: flex; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: wrap; }',
      // 按钮文字不许折行（窄面板里「恶点」会被挤成竖排两行）；挤不下时让滑块换到下一行。
      // 面板宽度随会话栏变化，真机上就撞到过这个问题。
      '[data-dgs] .dgs-ctl button { padding: 2px 6px; white-space: nowrap; flex: 0 0 auto; }',
      '[data-dgs] input[type=range] { flex: 1 1 90px; min-width: 80px; padding: 0; background: transparent; border: none; }',
      '[data-dgs] .dgs-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); margin-top: 4px; }',
      // ── 整页棋盘（主区域面板）：棋盘在左、问题手详细说明在右 ──────────────
      '[data-dgs].dgs-page { border: none; border-radius: 0; background: transparent;',
      '  margin: 0; padding: 12px 16px; max-width: none; height: 100%; box-sizing: border-box; }',
      '[data-dgs] .dgs-page-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '[data-dgs] .dgs-page-body { display: flex; gap: 16px; align-items: flex-start; margin-top: 10px; }',
      '[data-dgs] .dgs-page-board { flex: 0 1 auto; width: min(520px, 44vw); min-width: 240px; }',
      '[data-dgs] .dgs-page-list { flex: 1 1 320px; min-width: 0; max-height: 72vh; overflow-y: auto;',
      '  display: flex; flex-direction: column; gap: 6px; }',
      '[data-dgs] .dgs-page-item { width: 100%; text-align: left; padding: 7px 10px; }',
      '[data-dgs] .dgs-page-empty { margin-top: 16px; max-width: 620px; line-height: 1.8; }',
      '[data-dgs] .dgs-page-empty ul { margin: 6px 0 6px 18px; padding: 0; }',
      '[data-dgs] .dgs-icon { display: block; }',
      '[data-dgs] .dgs-prob { color: var(--dsw-alias-state-error-primary, #e5534b); }',
      '[data-dgs] .dgs-rec { color: var(--dsw-alias-state-success-primary, #3fb950); }',
      // ── 右侧栏文档预览（.sgf 在原生右侧栏里打开时的棋盘）────────────────
      '[data-dgs].dgs-doc { border: none; background: transparent; margin: 0; padding: 8px 10px;',
      '  max-width: none; border-radius: 0; }',
      '[data-dgs] .dgs-doc-head { display: flex; align-items: center; gap: 8px; }',
      '[data-dgs] .dgs-doc-head .dgs-spacer { flex: 1; }',
      '[data-dgs] .dgs-doc-status { font-size: 12px; margin: 6px 0 2px; }',
      '[data-dgs] .dgs-doc-board { width: 100%; max-width: 480px; margin: 0 auto; }',
      '[data-dgs] .dgs-doc-list { max-height: none; }',
    ].join('\n')

    /** 注入样式（幂等；只插一次，避免重复注册时堆积）。 */
    function ensureStyles() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) {
        // 非浏览器环境（测试桩）忽略
      }
    }

    /** 请求超过这么久还没回来，就说一句「在补算」——实测这类棋谱要等 1~2 分钟。 */
    var SLOW_HINT_DELAY = 5000

    /** 按标签上色：大恶手→error、失误→warn、其余→次要色。 */
    function severityColor(label) {
      var text = String(label == null ? '' : label)
      if (text.indexOf('大恶手') >= 0) return 'var(--dsw-alias-state-error-primary, #e5534b)'
      if (text.indexOf('失误') >= 0) return 'var(--dsw-alias-state-warn-primary, #d29922)'
      return 'var(--dsw-alias-label-secondary, #9aa4b2)'
    }

    // -----------------------------------------------------------------------
    // 内置棋盘：规则 + 渲染
    //
    // 为什么规则要写在客户端：让子、提子、虚着之后，盘面无法由"手顺列表"
    // 直接得出——中间某一步可能整块被提掉。判死活是画对棋盘的最小前提，
    // 所以这里带一份只做"落子/提子"的迷你规则（不含劫争判定：复盘场景下
    // 每一手都是棋谱上真实存在的着手，不会出现需要判劫的非法手）。
    // -----------------------------------------------------------------------

    /** 列标（跳过 I，与 sgf.js coordLabel 一致）。 */
    var BOARD_COLS = 'ABCDEFGHJKLMNOPQRST'
    /** SVG 视口是 100x100 的无量纲坐标，实际尺寸交给 CSS。 */
    var BOARD_VIEW = 100
    /** 边距：给坐标标注留出的空间（视口单位）。 */
    var BOARD_PAD = 8

    // ── 与 Lizzieyzy 对齐的视觉约定 ────────────────────────────────────────
    // 参照其 FloatBoardRenderer.java：drawMoveRankMark（最后一手 = 反色小圆点，
    // 半径 = 0.22 × 格宽）、drawMoveRankMarkCircle:1052（失误按严重度取
    // 紫/红/橙三档色）、drawLeelazSuggestions:1498（AI 首选 = 青色实心圆 +
    // 蓝色外圈，showBlueRing 默认开；其余候选按计算量在红→绿之间取色）、
    // drawStringForOrder:2811（推荐点信息 = 橙底黑字）、drawGoban:2892
    // （网格纯黑、外框线加粗、白子黑色描边）。用户平时看惯了这套配色，
    // 讲解时两边的"哪个点是什么意思"才对得上。
    var LAST_MOVE_R = 0.22
    var BEST_FILL = 'rgba(0, 255, 255, 0.5)' // theme best-move-color [0,255,255,240]
    var BEST_RING = '#0000ff' // Color.BLUE（showBlueRing）
    var BEST_INFO_BG = '#ffc800' // Color.ORANGE
    var PV_BLUE = '#1668ff'
    var MARK_COLORS = {
      blunder: '#9b1996', // (155,25,150) 最严重一档
      mistake: '#d01013', // (208,16,19)
      inaccuracy: '#c88c32', // (200,140,50)
    }

    /** 问题手标记色：优先按 labelKey，回退按中文标签（老版本 Host 不带 key）。 */
    function markColor(labelKey, labelText) {
      if (labelKey !== undefined && MARK_COLORS[labelKey] !== undefined) return MARK_COLORS[labelKey]
      var text = String(labelText == null ? '' : labelText)
      if (text.indexOf('大恶手') >= 0) return MARK_COLORS.blunder
      if (text.indexOf('失误') >= 0) return MARK_COLORS.mistake
      return MARK_COLORS.inaccuracy
    }

    /** 交叉点 -> 人类标签（如 (15,3) -> 'Q16'）。 */
    function boardLabel(x, y, size) {
      var col = x >= 0 && x < BOARD_COLS.length ? BOARD_COLS.charAt(x) : String(x)
      return col + String(size - y)
    }

    /**
     * KataGo 风格标签（'R16'）-> {x, y}；解析不了或落在盘外返回 null。
     * 小棋盘（9/13 路）上引擎不会给出路数外的点，但标签来自棋谱/引擎文本，
     * 挡一道越界免得把标记画到盘外。
     */
    function parsePointLabel(label, size) {
      var m = /^([A-Za-z])(\d{1,2})$/.exec(String(label == null ? '' : label))
      if (m === null) return null
      var x = BOARD_COLS.indexOf(m[1].toUpperCase())
      var row = parseInt(m[2], 10)
      if (x < 0 || x >= size || !(row >= 1 && row <= size)) return null
      return { x: x, y: size - row }
    }

    /** 空盘：0 空、1 黑、2 白；下标 = y * size + x。 */
    function emptyGrid(size) {
      var grid = new Array(size * size)
      for (var i = 0; i < grid.length; i++) grid[i] = 0
      return grid
    }

    /**
     * 取 (x,y) 所在棋串的同色点与气数（气点去重）。空点返回 null。
     * @returns {{ stones: number[][], libs: number }|null}
     */
    function groupAt(grid, size, x, y) {
      var color = grid[y * size + x]
      if (color === 0) return null
      var stones = []
      var libs = 0
      var seen = {}
      var stack = [[x, y]]
      seen[y * size + x] = true
      while (stack.length > 0) {
        var p = stack.pop()
        stones.push(p)
        var nb = [[p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]]
        for (var i = 0; i < nb.length; i++) {
          var nx = nb[i][0]
          var ny = nb[i][1]
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
          var key = ny * size + nx
          if (seen[key] === true) continue
          seen[key] = true
          var v = grid[key]
          if (v === 0) libs += 1
          else if (v === color) stack.push([nx, ny])
        }
      }
      return { stones: stones, libs: libs }
    }

    /** 落子并提掉无气的对方棋串；返回被提子数。 */
    function playStone(grid, size, x, y, color) {
      grid[y * size + x] = color
      var opp = color === 1 ? 2 : 1
      var captured = 0
      var nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      for (var i = 0; i < nb.length; i++) {
        var nx = nb[i][0]
        var ny = nb[i][1]
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        if (grid[ny * size + nx] !== opp) continue
        var g = groupAt(grid, size, nx, ny)
        if (g !== null && g.libs === 0) {
          for (var j = 0; j < g.stones.length; j++) {
            grid[g.stones[j][1] * size + g.stones[j][0]] = 0
            captured += 1
          }
        }
      }
      var own = groupAt(grid, size, x, y)
      if (own !== null && own.libs === 0) {
        // 自杀：真实棋谱不会出现，防御性清掉，免得不合规则的谱把棋盘画坏
        for (var k = 0; k < own.stones.length; k++) grid[own.stones[k][1] * size + own.stones[k][0]] = 0
      }
      return captured
    }

    /**
     * 摆出「前 upto 手」的局面（含 AB/AW 摆子）。
     *
     * 结果按「同一个 board 对象 + 同一手数」缓存：面板每敲一个字符都会重渲染，
     * 而重算一次要重放整局棋；用对象标识做键既便宜，也不会把两盘棋搞混。
     * （返回的数组由调用方只读使用，不再复制。）
     *
     * @param {{ size: number, moves: object[], setup?: object }} board 服务端 compactBoard 的产物
     * @param {number} upto 显示到第几手（0 = 开局）
     * @returns {number[]} 盘面网格（0 空 / 1 黑 / 2 白，下标 = y * size + x）
     */
    function boardAt(board, upto) {
      var size = board.size
      var moves = board.moves || []
      var limit = Math.max(0, Math.min(upto, moves.length))
      if (boardCache.board === board && boardCache.upto === limit) return boardCache.grid
      var grid = emptyGrid(size)
      var setup = board.setup || {}
      var black = setup.black || []
      var white = setup.white || []
      var i
      for (i = 0; i < black.length; i++) grid[black[i][1] * size + black[i][0]] = 1
      for (i = 0; i < white.length; i++) grid[white[i][1] * size + white[i][0]] = 2
      for (i = 0; i < limit; i++) {
        var m = moves[i]
        if (m.x < 0 || m.y < 0) continue
        playStone(grid, size, m.x, m.y, m.c === 'B' ? 1 : 2)
      }
      boardCache.board = board
      boardCache.upto = limit
      boardCache.grid = grid
      return grid
    }

    /** 盘面缓存：{ board 对象标识, 手数 } -> 网格。 */
    var boardCache = { board: null, upto: -1, grid: null }

    /** 星位（19/13/9 路常用坐标，其余路数不画）。 */
    function starPoints(size) {
      var base = size === 19 ? [3, 9, 15] : size === 13 ? [3, 6, 9] : size === 9 ? [2, 4, 6] : []
      var out = []
      for (var i = 0; i < base.length; i++) {
        for (var j = 0; j < base.length; j++) out.push([base[i], base[j]])
      }
      return out
    }

    /**
     * 画一张棋盘（SVG）。
     * @param {object} opts
     * @param {object} opts.board 服务端棋盘数据
     * @param {number} opts.upto 显示到第几手
     * @param {object|null} opts.problem 当前手的问题手标记（{x, y, key, label}）或 null
     * @param {Array<object|null>} [opts.pv] 变化图前几手的坐标（第 0 项 = AI 首选）
     * @param {string} [opts.hintLabel] 首选点旁的信息文本（胜率等）
     * @param {function} [opts.onPick] 点击交叉点回调 (x, y)
     * @returns {object} React 元素
     */
    function renderBoard(opts) {
      var size = opts.board.size
      var moves = opts.board.moves || []
      var grid = boardAt(opts.board, opts.upto)
      var step = (BOARD_VIEW - BOARD_PAD * 2) / Math.max(1, size - 1)
      var pos = function (i) { return BOARD_PAD + i * step }
      var radius = step * 0.46
      var kids = []

      kids.push(React.createElement('rect', {
        key: 'bg', x: 0, y: 0, width: BOARD_VIEW, height: BOARD_VIEW, rx: 1.5, fill: 'url(#dgs-wood)',
      }))
      var i
      // 网格：纯黑 + 外框加粗（Lizzieyzy drawGoban 的 borderStroke/normalStroke 之分）
      for (i = 0; i < size; i++) {
        var edge = i === 0 || i === size - 1
        var lineW = edge ? 0.55 : 0.28
        kids.push(React.createElement('line', {
          key: 'h' + i, x1: pos(0), y1: pos(i), x2: pos(size - 1), y2: pos(i),
          stroke: '#111111', strokeWidth: lineW,
        }))
        kids.push(React.createElement('line', {
          key: 'v' + i, x1: pos(i), y1: pos(0), x2: pos(i), y2: pos(size - 1),
          stroke: '#111111', strokeWidth: lineW,
        }))
      }
      starPoints(size).forEach(function (p, index) {
        kids.push(React.createElement('circle', {
          key: 'star' + index, cx: pos(p[0]), cy: pos(p[1]), r: 0.75, fill: '#111111',
        }))
      })
      // 坐标：列标在上、行号在左（讲解里说"Q16"时，学生能在盘上直接找到）
      for (i = 0; i < size; i++) {
        kids.push(React.createElement('text', {
          key: 'col' + i, x: pos(i), y: BOARD_PAD / 2 + 1.4, fontSize: 2.8, fill: '#111111',
          textAnchor: 'middle',
        }, BOARD_COLS.charAt(i)))
        kids.push(React.createElement('text', {
          key: 'row' + i, x: BOARD_PAD / 2, y: pos(i) + 1.1, fontSize: 2.8, fill: '#111111',
          textAnchor: 'middle',
        }, String(size - i)))
      }

      // 棋子（白子带黑色描边，与 Lizzieyzy drawStoneSimple 一致）
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var v = grid[y * size + x]
          if (v === 0) continue
          var isBlack = v === 1
          kids.push(React.createElement('circle', {
            key: 'st' + x + '_' + y,
            className: isBlack ? 'dgs-stone dgs-stone-b' : 'dgs-stone dgs-stone-w',
            cx: pos(x), cy: pos(y), r: radius,
            fill: isBlack ? 'url(#dgs-black)' : 'url(#dgs-white)',
            stroke: isBlack ? 'none' : '#111111',
            strokeWidth: isBlack ? 0 : Math.max(0.12, radius / 16),
          }))
        }
      }

      // 最后一手：反色小实心圆点，半径 0.22 格宽（Lizzieyzy 的最后一手指示）
      var lastIndex = Math.max(0, Math.min(opts.upto, moves.length)) - 1
      var last = lastIndex >= 0 ? moves[lastIndex] : null
      if (last !== null && last.x >= 0) {
        kids.push(React.createElement('circle', {
          key: 'last', cx: pos(last.x), cy: pos(last.y), r: step * LAST_MOVE_R,
          fill: last.c === 'B' ? '#f3f4f6' : '#141519', pointerEvents: 'none',
        }))
      }

      // 所有问题手：每处点一个小色点（Lizzieyzy 的着法质量色块同款做法），
      // 这样**不跳到那一手也看得见**问题都出在哪；当前停在问题手上时再套一个大圈。
      var marks = Array.isArray(opts.marks) ? opts.marks : []
      marks.forEach(function (m, index) {
        kids.push(React.createElement('circle', {
          key: 'mark' + index, cx: pos(m.x), cy: pos(m.y), r: step * 0.16,
          fill: m.color, fillOpacity: 0.92, pointerEvents: 'none',
        }))
      })

      // 当前这一手的问题手：大圈强调（颜色＝严重度）
      if (opts.problem !== null && opts.problem !== undefined) {
        kids.push(React.createElement('circle', {
          key: 'problem', cx: pos(opts.problem.x), cy: pos(opts.problem.y), r: radius * 1.12,
          fill: 'none', stroke: markColor(opts.problem.key, opts.problem.label),
          strokeWidth: 0.7, pointerEvents: 'none',
        }))
      }

      // 变化图（PV）：首选点 = 青色实心圆 + 蓝圈；后续几手 = 蓝点 + 序号
      var pv = Array.isArray(opts.pv) ? opts.pv : []
      pv.forEach(function (p, index) {
        if (p === null || p === undefined) return
        if (index === 0) {
          kids.push(React.createElement('circle', {
            key: 'best', cx: pos(p.x), cy: pos(p.y), r: radius + 0.2, fill: BEST_FILL,
            pointerEvents: 'none',
          }))
          kids.push(React.createElement('circle', {
            key: 'bestring', cx: pos(p.x), cy: pos(p.y), r: radius + 0.6, fill: 'none',
            stroke: BEST_RING, strokeWidth: 0.45, pointerEvents: 'none',
          }))
        } else if (grid[p.y * size + p.x] === 0) {
          // 变化图的手如果落在实战已占的点上（那条变化与当前局面无关），不画——
          // 画上去会像是把子叠在子上，反而误导
          kids.push(React.createElement('circle', {
            key: 'pv' + index, cx: pos(p.x), cy: pos(p.y), r: radius * 0.58, fill: PV_BLUE,
            pointerEvents: 'none',
          }))
          kids.push(React.createElement('text', {
            key: 'pvt' + index, x: pos(p.x), y: pos(p.y) + 0.85, fontSize: 2.3, fill: '#ffffff',
            textAnchor: 'middle', pointerEvents: 'none',
          }, String(index + 1)))
        }
      })

      // 首选点的胜率：橙底黑字（Lizzieyzy drawStringForOrder 的信息条样式）。
      // pv[0] 可能解析失败（候选标签不是坐标，比如 'pass' 或空字符串）——
      // 那时只能不画信息条：渲染期抛错会整块面板一起挂掉。
      if (opts.hintLabel && pv.length > 0 && pv[0] !== null && pv[0] !== undefined) {
        var text = String(opts.hintLabel)
        var boxW = text.length * 1.55 + 1.6
        var boxX = Math.max(0, Math.min(BOARD_VIEW - boxW, pos(pv[0].x) + radius * 0.9))
        var boxY = Math.max(0, pos(pv[0].y) - radius * 2.6)
        kids.push(React.createElement('rect', {
          key: 'hinlabelbg', x: boxX, y: boxY, width: boxW, height: 3.4, fill: BEST_INFO_BG,
          pointerEvents: 'none',
        }))
        kids.push(React.createElement('text', {
          key: 'hinlabel', x: boxX + boxW / 2, y: boxY + 2.5, fontSize: 2.5, fill: '#000000',
          textAnchor: 'middle', pointerEvents: 'none',
        }, text))
      }

      if (typeof opts.onPick === 'function') {
        kids.push(React.createElement('rect', {
          key: 'hit', x: 0, y: 0, width: BOARD_VIEW, height: BOARD_VIEW, fill: 'transparent',
          style: { cursor: 'crosshair' },
          onClick: function (event) {
            try {
              var box = event.currentTarget.getBoundingClientRect()
              var px = (event.clientX - box.left) / (box.width || 1) * BOARD_VIEW
              var py = (event.clientY - box.top) / (box.height || 1) * BOARD_VIEW
              var gx = Math.round((px - BOARD_PAD) / step)
              var gy = Math.round((py - BOARD_PAD) / step)
              opts.onPick(Math.max(0, Math.min(size - 1, gx)), Math.max(0, Math.min(size - 1, gy)))
            } catch (error) {
              /* 点击失败绝不能影响面板 */
            }
          },
        }))
      }

      kids.unshift(React.createElement('defs', { key: 'defs' },
        React.createElement('linearGradient', { id: 'dgs-wood', x1: '0', y1: '0', x2: '0', y2: '1' },
          React.createElement('stop', { offset: '0%', stopColor: '#e8c383' }),
          React.createElement('stop', { offset: '100%', stopColor: '#d6a75d' })),
        React.createElement('radialGradient', { id: 'dgs-black', cx: '35%', cy: '30%', r: '78%' },
          React.createElement('stop', { offset: '0%', stopColor: '#5c6169' }),
          React.createElement('stop', { offset: '55%', stopColor: '#22242a' }),
          React.createElement('stop', { offset: '100%', stopColor: '#0b0c0f' })),
        React.createElement('radialGradient', { id: 'dgs-white', cx: '35%', cy: '30%', r: '78%' },
          React.createElement('stop', { offset: '0%', stopColor: '#ffffff' }),
          React.createElement('stop', { offset: '62%', stopColor: '#edeff3' }),
          React.createElement('stop', { offset: '100%', stopColor: '#c3c9d2' })),
      ))

      return React.createElement('svg', {
        className: 'dgs-board', viewBox: '0 0 ' + BOARD_VIEW + ' ' + BOARD_VIEW,
        xmlns: 'http://www.w3.org/2000/svg', 'data-dgs-board': String(size),
      }, kids)
    }

    /** 取路径的末段（跨 Windows/Unix 两种分隔符）。 */
    function baseName(path) {
      return String(path == null ? '' : path).replace(/\\/g, '/').split('/').pop()
    }

    /** 路径归一化：反斜杠转正斜杠、去掉尾部斜杠、转小写（Windows 大小写不敏感）。 */
    function normPath(path) {
      return String(path == null ? '' : path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /**
     * 判断两个路径是不是同一个文件。
     *
     * 只在文件名上比会把「两盘都叫 game.sgf 的棋」认成一盘（跳到错的手数而不是载入）；
     * 只在完整路径上比又会在「面板里是绝对路径、工具调用里是相对路径」时永远认不出，
     * 于是每轮都重新载入。所以：能整体相等或后缀包含就按路径认，剩下才退回文件名。
     */
    function sameFile(a, b) {
      var x = normPath(a)
      var y = normPath(b)
      if (x === '' || y === '') return false
      if (x === y) return true
      if (x.indexOf('/') < 0 || y.indexOf('/') < 0) return baseName(x) === baseName(y)
      return x.length > y.length ? x.endsWith('/' + y) : y.endsWith('/' + x)
    }

    /** 棋盘表头状态：「第 5/106 手 · 黑 Q16」。 */
    function boardStatusText(board, cur, move) {
      var total = board.moves.length
      if (cur <= 0) return '开局 · 共 ' + total + ' 手'
      var who = move && move.c === 'B' ? '黑' : '白'
      var where = move && move.x >= 0 ? boardLabel(move.x, move.y, board.size) : '虚着'
      return '第 ' + cur + '/' + total + ' 手 · ' + who + ' ' + where
    }

    /**
     * 「跟随讲解」游标（面板级）。
     * - seq：已经**应用**到棋盘的指针序号（同一件旧事不再重复应用）；
     * - seen：已经**见过**的最大序号（用户手动载入时用它把旧指针认掉）；
     * - failures：连续轮询失败次数（连接失效时用来给出可诊断的提示）；
     * - tried：失败过的自动载入，防止路径解析不了时每 3 秒重试一次。
     */
    var focusPointer = { seq: 0, seen: 0, failures: 0, tried: {} }

    // -----------------------------------------------------------------------
    // 两份 UI 的共享状态：输入框下方的面板（控制器）＋ 左侧栏点开的整页棋盘
    //
    // 为什么需要：同一个插件注册了两处 UI，它们得显示同一盘棋、同一手。
    // 宿主仍是数据的唯一来源（两边都从 /go-sensei/review 拿），但"现在停在第几手、
    // 棋盘展开没有、跟不跟随"这类**视图状态**必须共享，否则在一边翻手另一边不动，
    // 看着像两个程序。
    //
    // 面板是控制器（有路径输入、负责读取并把结果发布出来），整页是大视图。
    // 注意单测里的 React 桩把 useEffect 实现成空操作，所以"发布/订阅"在测试里
    // 不参与，面板的本地 state 依旧是它渲染的直接来源 —— 既有测试行为不变。
    // -----------------------------------------------------------------------
    /** 左侧栏图标位与主区域面板共用的 id（外壳按这个 id 把两者对上）。 */
    var PANEL_ID = 'go-sensei-board'
    var senseiStore = {
      data: null,
      path: '',
      upto: 0,
      // 面板自己展开/收起的状态也要共享：主区域一次只渲染一个面板，切到整页棋盘
      // 再切回来时 dock 是重新挂载的——不共享的话用户每次回来都要再点一次「展开」。
      open: false,
      boardOpen: false,
      follow: true,
      subs: [],
    }

    /** 写入共享状态，值真的变了才通知订阅者。 */
    function senseiPatch(patch) {
      var changed = false
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && senseiStore[key] !== patch[key]) {
          senseiStore[key] = patch[key]
          changed = true
        }
      }
      if (!changed) return
      var subs = senseiStore.subs.slice()
      for (var i = 0; i < subs.length; i++) {
        try {
          subs[i]()
        } catch (error) {
          /* 一个订阅者出错不影响其它订阅者 */
        }
      }
    }

    /** 订阅共享状态；返回退订函数。 */
    function senseiSubscribe(fn) {
      senseiStore.subs.push(fn)
      return function () {
        var index = senseiStore.subs.indexOf(fn)
        if (index >= 0) senseiStore.subs.splice(index, 1)
      }
    }

    /** 组件里读取共享状态并跟随更新。 */
    function useSenseiStore() {
      var state = React.useState(0)
      var setTick = state[1]
      React.useEffect(function () {
        return senseiSubscribe(function () { setTick(function (n) { return n + 1 }) })
      }, [])
      return senseiStore
    }

    /** 左侧栏的「Sensei 棋盘」图标：外壳给 size/active，配色随主题走。 */
    function SenseiPanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      var active = props !== null && props !== undefined && props.active === true
      return React.createElement('svg', {
        className: 'dgs-icon', width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.1,
        'aria-hidden': 'true', opacity: active ? 1 : 0.82,
      },
        React.createElement('rect', { key: 'b', x: 1.6, y: 1.6, width: 12.8, height: 12.8, rx: 1.4 }),
        React.createElement('line', { key: 'h', x1: 1.6, y1: 8, x2: 14.4, y2: 8 }),
        React.createElement('line', { key: 'v', x1: 8, y1: 1.6, x2: 8, y2: 14.4 }),
        React.createElement('circle', { key: 's1', cx: 5.2, cy: 5.2, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { key: 's2', cx: 10.8, cy: 10.8, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** 由服务端读取到的候选，拼出可直接发送的追问语。 */
    function followUpText(candidate, path) {
      var where = candidate.coordLabel ? '（这手下在 ' + candidate.coordLabel + '）' : ''
      var suggest = candidate.pv && candidate.pv[0] && candidate.pv[0].label
        ? '，AI 推荐 ' + candidate.pv[0].label
        : ''
      return '追问：第 ' + candidate.moveNumber + ' 手' + where + suggest
        + '，这手为什么不好？改下哪里会更好？请结合局面与候选变化讲解。'
        + (path ? '（棋谱：' + path + '）' : '')
    }

    /** 空实现：插槽 props 缺 inputActions 时的安全兜底。 */
    function noActions() {
      return {
        setDraft: function () {},
        addAttachments: function () { return false },
        removeAttachment: function () {},
        pruneAttachments: function () {},
        submit: function () {},
      }
    }

    /**
     * 整页棋盘（主区域面板）：棋盘在左、问题手详细说明在右。
     *
     * 与 dock 面板的分工：dock 负责"读棋谱 + 插入追问"（只有它拿得到 inputActions），
     * 这里负责"看得大、看得全"（没有输入框能力，所以点一行改为复制追问语）。
     * 两边共用 senseiStore，所以在哪边翻手、开关跟随，另一边立刻同步。
     */
    function SenseiBoardPage() {
      var store = useSenseiStore()
      var copyState = React.useState('')
      var copied = copyState[0]
      var setCopied = copyState[1]

      var data = store.data
      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(store.upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null
      var problem = null
      for (var pi = 0; pi < list.length; pi++) {
        if (list[pi].moveNumber === cur) { problem = list[pi]; break }
      }
      var hint = problem && problem.pv && problem.pv[0] ? problem.pv[0] : null
      var pvPoints = board === null || problem === null || !Array.isArray(problem.pv)
        ? []
        : problem.pv.slice(0, 3).map(function (p) { return parsePointLabel(p && p.label, board.size) })
      var problemMarks = []
      if (board !== null) {
        for (var mi = 0; mi < list.length; mi++) {
          var cand = list[mi]
          var mv = typeof cand.moveNumber === 'number' ? board.moves[cand.moveNumber - 1] : null
          if (mv !== undefined && mv !== null && mv.x >= 0) {
            problemMarks.push({ x: mv.x, y: mv.y, color: markColor(cand.labelKey, cand.label) })
          }
        }
      }
      var problemMoves = []
      for (var qi = 0; qi < list.length; qi++) {
        if (typeof list[qi].moveNumber === 'number' && list[qi].moveNumber > 0) problemMoves.push(list[qi].moveNumber)
      }
      problemMoves.sort(function (a, b) { return a - b })
      var nextProblem = null
      var prevProblem = null
      if (problemMoves.length > 0) {
        for (var ni = 0; ni < problemMoves.length; ni++) {
          if (problemMoves[ni] > cur) { nextProblem = problemMoves[ni]; break }
        }
        if (nextProblem === null) nextProblem = problemMoves[0]
        for (var pj = problemMoves.length - 1; pj >= 0; pj--) {
          if (problemMoves[pj] < cur) { prevProblem = problemMoves[pj]; break }
        }
        if (prevProblem === null) prevProblem = problemMoves[problemMoves.length - 1]
      }

      /**
       * 整页视图自己也要轮询跟随：主区域一次只渲染一个面板，切到这一页时输入框下方
       * 那块面板已经被卸载（它的轮询也随之停了）。没有这一段，整页就成了"看着像跟随
       * 讲解开着、其实永远不动"。
       */
      function loadIntoStore(target, cwdOverride) {
        var wanted = String(target == null ? '' : target).trim()
        if (wanted === '') return
        var key = wanted + '|' + String(cwdOverride || '')
        var last = focusPointer.tried[key] || 0
        if (Date.now() - last < 20000) return
        focusPointer.tried[key] = Date.now()
        var url = '/go-sensei/review?path=' + encodeURIComponent(wanted)
          + (cwdOverride ? '&cwd=' + encodeURIComponent(cwdOverride) : '')
        fetch(url)
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (!body || body.ok !== true || !body.data) return
            var next = body.data
            var nextBoard = next.board && Array.isArray(next.board.moves) ? next.board : null
            var nextTotal = nextBoard === null ? 0 : nextBoard.moves.length
            var nextList = Array.isArray(next.candidates) ? next.candidates : []
            var worst = nextList.length > 0 && typeof nextList[0].moveNumber === 'number' ? nextList[0].moveNumber : 0
            senseiPatch({
              data: next, path: wanted,
              upto: worst > 0 ? Math.min(worst, nextTotal) : nextTotal,
            })
          })
          .catch(function () { /* 下一轮再试 */ })
      }

      function pollFocusPage() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            var loaded = senseiStore.data && senseiStore.data.path ? senseiStore.data.path : ''
            if (loaded !== '' && sameFile(loaded, f.path || f.name || '')) {
              if (typeof f.moveNumber === 'number' && f.moveNumber > 0) senseiPatch({ upto: f.moveNumber })
              return
            }
            loadIntoStore(f.path, f.cwd)
          })
          .catch(function () { /* 轮询失败静默重试 */ })
      }

      React.useEffect(function () {
        if (!store.follow) return undefined
        var timer = setInterval(pollFocusPage, 3000)
        pollFocusPage()
        return function () { clearInterval(timer) }
      }, [store.follow, store.data])

      function copyFollowUp(candidate) {
        var text = followUpText(candidate, data ? data.path : '')
        var done = function () { setCopied('已复制第 ' + candidate.moveNumber + ' 手的追问语——粘到下面的输入框回车即可') }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { setCopied('复制失败：请手动选中文字') })
            return
          }
        } catch (error) {
          /* 走下面的兜底提示 */
        }
        setCopied('这段是本页要问的话，请手动复制：' + text)
      }

      var head = React.createElement('div', { className: 'dgs-page-head' },
        React.createElement('span', { className: 'dgs-title' }, 'DeepGo Sensei · 棋盘'),
        React.createElement('span', { className: 'dgs-sub' },
          board === null ? '还没有棋谱' : boardStatusText(board, cur, curMove)),
        React.createElement('span', { className: 'dgs-spacer' }),
        board === null ? null : React.createElement('button', {
          className: 'dgs-follow',
          title: '开启后：Sensei 在对话里讲到哪一盘、第几手，这里自动跟过去',
          onClick: function () { senseiPatch({ follow: !store.follow }) },
        }, store.follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
      )

      if (board === null) {
        return React.createElement('div', { className: 'dgs-page', 'data-dgs': '' }, head,
          React.createElement('div', { className: 'dgs-page-empty' },
            React.createElement('div', null, '这里放整页棋盘。还没有棋谱可以显示——两种方式任选：'),
            React.createElement('ul', null,
              React.createElement('li', null, '① 回到对话，在输入框下方的「DeepGo Sensei」面板里读一张棋谱；'),
              React.createElement('li', null, '② 或者直接让 Sensei 复盘一盘棋——右下角开着「跟随讲解」时，这里会自动载入它讲的那盘棋。')),
            React.createElement('div', { className: 'dgs-sub' }, '两边显示的是同一盘棋、同一手：在任一边翻手或开关跟随，另一边立刻同步。')))
      }

      var ctl = React.createElement('div', { className: 'dgs-ctl' },
        React.createElement('button', { onClick: function () { senseiPatch({ upto: 0 }) }, title: '回到开局' }, '⏮'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: Math.max(0, cur - 1) }) }, title: '上一手' }, '◀'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: Math.min(total, cur + 1) }) }, title: '下一手' }, '▶'),
        React.createElement('button', { onClick: function () { senseiPatch({ upto: total }) }, title: '跳到末手' }, '⏭'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: prevProblem === null,
          title: prevProblem === null ? '这盘棋没有发现明显问题手' : '跳到上一个恶点（第 ' + prevProblem + ' 手）',
          onClick: function () { if (prevProblem !== null) senseiPatch({ upto: prevProblem }) },
        }, '◀恶点'),
        React.createElement('button', {
          className: 'dgs-jump', disabled: nextProblem === null,
          title: nextProblem === null ? '这盘棋没有发现明显问题手' : '跳到下一个恶点（第 ' + nextProblem + ' 手）',
          onClick: function () { if (nextProblem !== null) senseiPatch({ upto: nextProblem }) },
        }, '恶点▶'),
        React.createElement('input', {
          type: 'range', min: 0, max: total, value: cur,
          title: '拖动快速定位',
          onChange: function (event) { senseiPatch({ upto: Number(event.target.value) }) },
        }),
      )

      var rows = list.map(function (candidate, index) {
        var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
        var pvText = Array.isArray(candidate.pv) && candidate.pv.length > 0
          ? candidate.pv.map(function (p) { return String(p && p.label ? p.label : '') })
              .filter(function (t) { return t !== ''; }).join(' → ')
          : ''
        return React.createElement('button', {
          className: 'dgs-page-item',
          key: String(candidate.moveNumber) + '-' + index,
          title: '点击：棋盘跳到这一手，并复制追问语',
          onClick: function () {
            senseiPatch({ upto: candidate.moveNumber })
            copyFollowUp(candidate)
          },
        },
          React.createElement('div', { className: 'dgs-l1' },
            React.createElement('span', { className: 'dgs-mv' }, '第 ' + candidate.moveNumber + ' 手'),
            React.createElement('span', null, candidate.color === 'B' ? '黑' : '白'),
            React.createElement('span', { className: 'dgs-coord' }, candidate.coordLabel || candidate.coord || ''),
            React.createElement('span', {
              className: 'dgs-badge',
              style: { color: severityColor(candidate.label) },
            }, candidate.label || ''),
          ),
          React.createElement('div', { className: 'dgs-l2' },
            '−' + (candidate.winrateLoss == null ? '?' : candidate.winrateLoss) + '% 胜率'
            + (candidate.scoreLoss == null ? '' : ' · ' + candidate.scoreLoss + ' 目')
            + (top && top.label ? '　AI 首选 ' + String(top.label)
                + (top.winratePct == null ? '' : '（胜率 ' + String(top.winratePct) + '%）') : '')),
          pvText === '' ? null : React.createElement('div', { className: 'dgs-l2' }, '变化：' + pvText),
        )
      })

      return React.createElement('div', { className: 'dgs-page', 'data-dgs': '' }, head, ctl,
        copied === '' ? null : React.createElement('div', { className: 'dgs-ok' }, copied),
        React.createElement('div', { className: 'dgs-page-body' },
          React.createElement('div', { className: 'dgs-page-board' },
            renderBoard({
              board: board, upto: cur, problem: problemPointOf(problem, curMove),
              marks: problemMarks, pv: pvPoints,
              hintLabel: hint && hint.label ? hint.label : '',
            }),
            React.createElement('div', { className: 'dgs-note' },
              problem !== null
                ? '○ 实战这一手是问题手　◌ AI 首选（青圆蓝圈）　蓝点＝变化图后续'
                : problemMarks.length > 0
                  ? '● 盘上色点＝问题手（紫＞红＞橙）：点右边任意一行跳过去'
                  : '未发现明显问题手'),
          ),
          React.createElement('div', { className: 'dgs-page-list' },
            list.length === 0
              ? React.createElement('div', { className: 'dgs-sub' }, '这盘棋没有发现问题手')
              : rows),
        ))
    }

    /** 问题手 + 当前手 → 棋盘上那个大圈的坐标（两侧 UI 共用）。 */
    function problemPointOf(problem, curMove) {
      if (problem === null || curMove === null || curMove === undefined || curMove.x < 0) return null
      return { x: curMove.x, y: curMove.y, key: problem.labelKey, label: problem.label }
    }

    /**
     * 复盘入口（composer dock）。展开后：路径输入 + 读取 + 问题手列表。
     * props.inputActions.setDraft 是「真正把文字写进输入框」的动词。
     */
    function SenseiPanel(props) {
      var actions = props && props.inputActions ? props.inputActions : noActions()
      // 初值取自共享状态：面板可能因为切到整页棋盘而被卸载再挂回来
      // （主区域一次只渲染一个面板），那时它必须接着显示原来那盘棋、原来那一手。
      var state = React.useState(senseiStore.path)
      var path = state[0]
      var setPath = state[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var dataState = React.useState(senseiStore.data)
      var data = dataState[0]
      var setData = dataState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var hintState = React.useState('')
      var hint = hintState[0]
      var setHint = hintState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var openState = React.useState(senseiStore.open)
      var open = openState[0]
      var setOpen = openState[1]
      // 内置棋盘：收起态只留一行表头；展开后才有棋盘本体与控制条
      var boardOpenState = React.useState(senseiStore.boardOpen)
      var boardOpen = boardOpenState[0]
      var setBoardOpen = boardOpenState[1]
      // 棋盘显示到第几手（0 = 开局）；载入棋谱后默认停在最严重的问题手
      var uptoState = React.useState(senseiStore.upto)
      var upto = uptoState[0]
      var setUpto = uptoState[1]
      // 跟随讲解：Sensei 讲到哪一手，棋盘就跳到哪一手
      var followState = React.useState(senseiStore.follow)
      var follow = followState[0]
      var setFollow = followState[1]
      // 跟随讲解连续失败时的如实说明（页面连接失效时不再静默）
      var followNoteState = React.useState('')
      var followNote = followNoteState[0]
      var setFollowNote = followNoteState[1]

      // 会话工作区根：客户端快照里没有 cwd 字段，这里只作「锦上添花」尝试；
      // 真正可靠的基准由 Host 用 tools/result 记下的工作区根提供。
      var cwd = ''
      // 会话 id：相对路径的解析基准由宿主按 id 反查（浏览器拿不到会话 cwd），
      // 这样重启后还没调用过任何 go_* 工具时也能直接读相对路径。
      var sessionId = ''
      try {
        var snapshot = props && typeof props.useSession === 'function'
          ? props.useSession(function (s) { return s })
          : null
        if (snapshot && snapshot.header && snapshot.header.cwd) cwd = String(snapshot.header.cwd)
        if (snapshot && snapshot.header && snapshot.header.id) sessionId = String(snapshot.header.id)
        else if (snapshot && snapshot.id) sessionId = String(snapshot.id)
      } catch (error) {
        cwd = ''
      }

      /**
       * 读取棋谱。cwdOverride 用于「跟随讲解」自动载入 —— 那时路径来自
       * 工具调用参数（可能是相对某个会话工作区的相对路径），基准与当前
       * 会话 cwd 未必相同，必须带上 Host 记下的那个。
       */
      function loadTarget(target, cwdOverride) {
        var wanted = String(target == null ? '' : target).trim()
        if (wanted === '') { setErr('请先填写 SGF 路径'); return }
        var base = String(cwdOverride == null ? '' : cwdOverride) || cwd
        setBusy(true); setErr(''); setNotice(''); setHint('')
        var url = '/go-sensei/review?path=' + encodeURIComponent(wanted)
          + (base ? '&cwd=' + encodeURIComponent(base) : '')
          + (sessionId ? '&session=' + encodeURIComponent(sessionId) : '')
        // 没有分析数据的棋谱要等宿主现场补算（真机实测 87 秒）。不给说明的话，
        // 按钮上一直写着「读取中…」，用户会以为卡死了。
        var slowTimer = setTimeout(function () {
          setHint('仍在读取：棋谱没有分析数据时，宿主会用 KataGo 现场补算（实测 1~2 分钟），算完自动出结果。')
        }, SLOW_HINT_DELAY)
        var done = function () { clearTimeout(slowTimer); setHint('') }
        fetch(url)
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            done()
            setBusy(false)
            if (body && body.ok === true) {
              setData(body.data)
              // 载入后停在哪一手：有问题手就停在**最严重的那一手**（讲解时最想看的就是
              // 它，盘上的标记也才立即可见），没有问题手才停在末手。
              var board = body.data && body.data.board ? body.data.board : null
              var total = board && Array.isArray(board.moves) ? board.moves.length : 0
              var list = body.data && Array.isArray(body.data.candidates) ? body.data.candidates : []
              var worst = list.length > 0 && typeof list[0].moveNumber === 'number' ? list[0].moveNumber : 0
              setUpto(worst > 0 ? Math.min(worst, total) : total)
              // 读取成功就把棋盘展开：不然用户读完了还只看到一行表头，
              // 得再点一下才知道盘上有东西（"棋盘不显示问题手"的观感有一半来自这里）
              setBoardOpen(true)
            } else {
              setData(null)
              setErr(body && body.error ? String(body.error) : '读取失败')
              if (body && body.hint) setHint(String(body.hint))
            }
          })
          .catch(function (error) {
            done()
            setBusy(false); setData(null); setErr(String(error && error.message ? error.message : error))
          })
      }

      function load() {
        loadTarget(path, '')
        // 手动读取＝用户此刻的选择：把已经见过的指针「认掉」，免得下一次轮询
        // 又用同一件旧事（比如别的会话留下的指针）把用户刚选的棋谱换掉。
        // 只有**新**的讲解事件（seq 更大）才会再切走。
        focusPointer.seq = focusPointer.seen
      }

      function insert(text) {
        actions.setDraft(text)
        setNotice('已插入输入框，回车即可发送')
      }

      /** 当前棋盘显示到第几手（对手数上限做了夹取）。 */
      function currentUpto() {
        var total = data && data.board && Array.isArray(data.board.moves) ? data.board.moves.length : 0
        return Math.max(0, Math.min(upto, total))
      }

      /**
       * 跟随讲解：轮询 Host 记下的「正在讲解的局面」指针。
       *
       * 为什么是轮询而不是推送：讲解发生在服务端的工具调用里，棋盘在浏览器；
       * 两者之间没有现成的会话通道。这条指针只读内存、不读盘，3 秒一次的
       * 代价可以忽略，而且只在"面板展开 + 棋盘展开 + 跟随开启"时才轮询。
       */
      function pollFocus() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (focusPointer.failures > 0) {
              focusPointer.failures = 0
              setFollowNote('')
            }
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            // seq 不比"已应用"更新就什么都不做：同一件旧事不该反复抢走用户选的棋谱
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            applyFocus(f)
          })
          .catch(function () {
            // 页面连接失效时（实测：dsh web 重启后浏览器对同源的连接池会废掉）
            // 轮询会一直失败。以前是静默重试，用户看到的就是"跟随讲解没反应"——
            // 连失败三次就把话说清楚，并给出唯一的恢复手段。
            focusPointer.failures = (focusPointer.failures || 0) + 1
            if (focusPointer.failures >= 3) {
              setFollowNote('跟随讲解：连续 ' + focusPointer.failures + ' 次没连上宿主——页面连接可能已失效，刷新页面（F5）即可恢复。')
            }
          })
      }

      /** 把指针落到棋盘上：同一盘棋就跳手数，另一盘棋就自动载入。 */
      function applyFocus(f) {
        var sameGame = data && data.path ? sameFile(data.path, f.path || f.name || '') : false
        if (!sameGame) {
          // 别急着反复重试：路径解析不了时（相对路径基准不对）20 秒内只试一次
          var key = String(f.path || '') + '|' + String(f.cwd || '')
          var last = focusPointer.tried[key] || 0
          if (Date.now() - last < 20000) return
          focusPointer.tried[key] = Date.now()
          setPath(String(f.path || ''))
          // 跟随把一盘棋带进来时顺手把棋盘展开：否则用户只看到表头，还是得再点一下
          setBoardOpen(true)
          loadTarget(f.path, f.cwd)
          return
        }
        if (typeof f.moveNumber === 'number' && f.moveNumber > 0) setUpto(f.moveNumber)
      }

      React.useEffect(function () {
        if (!open || !follow) return undefined
        // 已有棋谱但棋盘收着时不轮询（省请求）；**还没载入棋谱时必须轮询**，
        // 否则「跟随讲解」永远等不到 Sensei 正在讲的那盘棋（实测踩过这个死角）。
        if (data !== null && !boardOpen) return undefined
        var timer = setInterval(pollFocus, 3000)
        pollFocus()
        return function () { clearInterval(timer) }      }, [open, boardOpen, follow, data])

      /** 点棋盘交叉点 → 就这个点插入追问。 */
      function askPoint(x, y) {
        if (!data || !data.board) return
        var label = boardLabel(x, y, data.board.size)
        var cur = currentUpto()
        insert('追问：' + (cur > 0 ? '第 ' + cur + ' 手之后的局面，' : '开局（第 0 手），')
          + '如果下在 ' + label
          + ' 会怎样？请讲讲这一手的价值与后续变化。'
          + (data.path ? '（棋谱：' + data.path + '）' : ''))
      }

      /**
       * 面板 → 共享状态：把当前这盘棋、这一手、这些开关发布给整页棋盘。
       * 放在 effect 里（而不是渲染期）是必须的：渲染期改别人的状态，React 会报
       * "Cannot update a component while rendering a different component"。
       */
      React.useEffect(function () {
        senseiPatch({
          data: data, path: path, upto: upto,
          open: open, boardOpen: boardOpen, follow: follow,
        })
      }, [data, path, upto, open, boardOpen, follow])

      /** 共享状态 → 面板：整页棋盘那边翻手/开关时跟着走（比较后再 set，避免打转）。 */
      React.useEffect(function () {
        return senseiSubscribe(function () {
          if (senseiStore.open !== open) setOpen(senseiStore.open)
          if (senseiStore.upto !== upto) setUpto(senseiStore.upto)
          if (senseiStore.boardOpen !== boardOpen) setBoardOpen(senseiStore.boardOpen)
          if (senseiStore.follow !== follow) setFollow(senseiStore.follow)
        })
      }, [open, upto, boardOpen, follow])

      /**
       * 点问题手一行：棋盘跳到那一手（并自动展开棋盘），同时把追问语插进输入框。
       * 讲解场景里这两件事本来就该一起发生——看到问题手，也想立刻看到盘面。
       */
      function pickCandidate(candidate) {
        if (data && data.board) {
          setBoardOpen(true)
          if (typeof candidate.moveNumber === 'number' && candidate.moveNumber > 0) {
            setUpto(candidate.moveNumber)
          }
        }
        insert(followUpText(candidate, data ? data.path : ''))
      }

      var head = React.createElement('div', { className: 'dgs-head' },
        React.createElement('span', { className: 'dgs-title' }, 'DeepGo Sensei'),
        React.createElement('span', { className: 'dgs-sub' }, '点位复盘 · 点击问题手即插入追问'),
        React.createElement('span', { className: 'dgs-spacer' }),
        React.createElement('button', { onClick: function () { setOpen(!open) } }, open ? '收起' : '展开'),
      )

      if (!open) return React.createElement('div', { 'data-dgs': '' }, head)

      var kids = [
        React.createElement('div', { className: 'dgs-row', key: 'p' },
          React.createElement('input', {
            value: path,
            placeholder: 'SGF 路径（相对工作区或绝对路径）',
            onChange: function (event) { setPath(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') load() },
          }),
          React.createElement('button', { onClick: load, disabled: busy }, busy ? '读取中…' : '读取问题手'),
        ),
      ]
      if (notice) kids.push(React.createElement('div', { className: 'dgs-ok', key: 'n' }, notice))
      if (err) kids.push(React.createElement('div', { className: 'dgs-err', key: 'e' }, err))
      if (hint) kids.push(React.createElement('div', { className: 'dgs-sub', key: 'h' }, hint))

      // 棋盘状态先算出来：表头在**没载入棋谱时也要在**，否则用户没有开启「跟随讲解」
      // 的入口——而那正是"Sensei 讲到哪一盘，棋盘自动带出来"的唯一开关（实测踩过）。
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null
      // 当前手就是问题手吗？（问题手的 moveNumber 指"第 N 手"，即走完 N 手后的局面）
      var problem = null
      if (board !== null) {
        for (var pi = 0; pi < list.length; pi++) {
          if (list[pi].moveNumber === cur) { problem = list[pi]; break }
        }
      }
      var hint = problem && problem.pv && problem.pv[0] ? problem.pv[0] : null
      // 变化图前几手：与 Lizzieyzy 一样在盘上按序标出（首选 = 青圆蓝圈，后续 = 蓝点序号）
      var pvPoints = board === null || problem === null || !Array.isArray(problem.pv)
        ? []
        : problem.pv.slice(0, 3).map(function (p) { return parsePointLabel(p && p.label, board.size) })
      var problemPoint = problem !== null && curMove !== null && curMove.x >= 0
        ? { x: curMove.x, y: curMove.y, key: problem.labelKey, label: problem.label }
        : null
      // 所有问题手的位置：不跳到那一手也要在盘上看得见（小色点，颜色＝严重度）
      var problemMarks = []
      if (board !== null) {
        for (var mi = 0; mi < list.length; mi++) {
          var cand = list[mi]
          var mv = typeof cand.moveNumber === 'number' ? board.moves[cand.moveNumber - 1] : null
          if (mv !== undefined && mv !== null && mv.x >= 0) {
            problemMarks.push({ x: mv.x, y: mv.y, color: markColor(cand.labelKey, cand.label) })
          }
        }
      }
      // 「上一个 / 下一个恶点」的目标手数（升序；到头绕回另一端，方便把每个恶点过一遍）
      var problemMoves = []
      for (var qi = 0; qi < list.length; qi++) {
        if (typeof list[qi].moveNumber === 'number' && list[qi].moveNumber > 0) problemMoves.push(list[qi].moveNumber)
      }
      problemMoves.sort(function (a, b) { return a - b })
      var nextProblem = null
      var prevProblem = null
      if (problemMoves.length > 0) {
        for (var ni = 0; ni < problemMoves.length; ni++) {
          if (problemMoves[ni] > cur) { nextProblem = problemMoves[ni]; break }
        }
        if (nextProblem === null) nextProblem = problemMoves[0]
        for (var pj = problemMoves.length - 1; pj >= 0; pj--) {
          if (problemMoves[pj] < cur) { prevProblem = problemMoves[pj]; break }
        }
        if (prevProblem === null) prevProblem = problemMoves[problemMoves.length - 1]
      }

      // ── 棋盘表头（收起态只留这一行；未载入棋谱时说明状态并给出开启跟随的入口）──
      kids.push(React.createElement('div', { className: 'dgs-boardwrap', key: 'boardhead' },
        React.createElement('div', { className: 'dgs-boardhead' },
          React.createElement('button', {
            className: 'dgs-boardtoggle',
            title: boardOpen ? '收起棋盘' : '展开棋盘（点问题手也会自动展开并跳到那一手）',
            onClick: function () { setBoardOpen(!boardOpen) },
          }, boardOpen ? '棋盘 ▾' : '棋盘 ▸'),
          React.createElement('span', { className: 'dgs-sub' },
            board === null ? '未载入棋谱' : boardStatusText(board, cur, curMove)),
          React.createElement('button', {
            className: 'dgs-follow',
            title: '开启后：Sensei 在对话里讲到哪一盘、第几手，棋盘自动跟过去',
            onClick: function () { setFollow(!follow) },
          }, follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
        ),
      ))

      if (followNote) {
        kids.push(React.createElement('div', { className: 'dgs-err', key: 'follownote' }, followNote))
      }

      if (boardOpen && board === null) {
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'noboard' },
          follow
            ? '跟随讲解已开：Sensei 在对话里读到哪盘棋，棋盘会自动载入并跳到正在讲的那一手。也可以在上面填路径点「读取问题手」。'
            : '还没有棋谱：填路径后点「读取问题手」，或把「跟随讲解」打开，等 Sensei 讲到一盘棋时自动载入。'))
      }

      if (data) {
        // 补算状态照实显示：这类"读不到"的抱怨里，最需要一眼看清的就是
        // "宿主到底补算没有、补算成功没有"，否则用户只能看到「纯棋理 · 0 个问题手」。
        var auto = data.autoEngine && typeof data.autoEngine === 'object' ? data.autoEngine : null
        var autoText = ''
        if (auto !== null && auto.failed !== undefined) {
          autoText = ' · 补算未成功：' + String(auto.failed).slice(0, 40)
        } else if (auto !== null && typeof auto.moves === 'number') {
          autoText = ' · 引擎补算 ' + String(auto.moves) + ' 手'
            + (auto.seconds == null ? '' : '（' + String(auto.seconds) + ' 秒）')
        }
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'meta' },
          (data.mode === 'analysis' ? 'AI 分析' : '纯棋理') + ' · 难度 ' + String(data.level || '-')
          + ' · ' + String(data.moveCount || 0) + ' 手 / ' + String(data.variations || 0) + ' 变化图'
          + ' · ' + list.length + ' 个问题手' + autoText))

        var listEl = list.length === 0
          ? React.createElement('div', { className: 'dgs-sub', key: 'none' },
              data.mode === 'analysis'
                ? '未发现明显问题手'
                : auto !== null && auto.failed !== undefined
                  ? '棋谱没有可用的分析数据，补算也没成功（原因见上一行）'
                  : '棋谱没有可用的分析数据：这一档只能讲棋理，不报胜率与候选点')
          : React.createElement('div', { className: 'dgs-list', key: 'list' },
              list.map(function (candidate, index) {
                var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
                return React.createElement('button', {
                  className: 'dgs-item',
                  key: String(candidate.moveNumber) + '-' + index,
                  title: '点击：棋盘跳到这一手，并把追问语插入输入框',
                  onClick: function () { pickCandidate(candidate) },
                },
                  React.createElement('div', { className: 'dgs-l1' },
                    React.createElement('span', { className: 'dgs-mv' }, '第 ' + candidate.moveNumber + ' 手'),
                    React.createElement('span', null, candidate.color === 'B' ? '黑' : '白'),
                    React.createElement('span', { className: 'dgs-coord' }, candidate.coordLabel || candidate.coord || ''),
                    React.createElement('span', {
                      className: 'dgs-badge',
                      style: { color: severityColor(candidate.label) },
                    }, candidate.label || ''),
                  ),
                  React.createElement('div', { className: 'dgs-l2' },
                    '−' + (candidate.winrateLoss == null ? '?' : candidate.winrateLoss) + '% 胜率'
                    + (candidate.scoreLoss == null ? '' : ' / ' + candidate.scoreLoss + ' 目')
                    + (top && top.label ? ' · AI 首选：' + top.label : '')),
                )
              }),
            )

        if (boardOpen && board !== null) {
          var boardCol = React.createElement('div', { className: 'dgs-col-board' },
            renderBoard({
              board: board,
              upto: cur,
              problem: problemPoint,
              marks: problemMarks,
              pv: pvPoints,
              hintLabel: hint && hint.label ? hint.label : '',
              onPick: askPoint,
            }),
            React.createElement('div', { className: 'dgs-ctl' },
              React.createElement('button', { onClick: function () { setUpto(0) }, title: '回到开局' }, '⏮'),
              React.createElement('button', { onClick: function () { setUpto(Math.max(0, cur - 1)) }, title: '上一手' }, '◀'),
              React.createElement('button', { onClick: function () { setUpto(Math.min(total, cur + 1)) }, title: '下一手' }, '▶'),
              React.createElement('button', { onClick: function () { setUpto(total) }, title: '跳到末手' }, '⏭'),
              // 恶点跳转：复盘时最常用的两个动作（在盘上从头到尾把问题手过一遍）
              React.createElement('button', {
                className: 'dgs-jump',
                disabled: prevProblem === null,
                title: prevProblem === null ? '这盘棋没有发现明显问题手' : '跳到上一个恶点（第 ' + prevProblem + ' 手；到头绕回最后一个）',
                onClick: function () { if (prevProblem !== null) setUpto(prevProblem) },
              }, '◀恶点'),
              React.createElement('button', {
                className: 'dgs-jump',
                disabled: nextProblem === null,
                title: nextProblem === null ? '这盘棋没有发现明显问题手' : '跳到下一个恶点（第 ' + nextProblem + ' 手；到头绕回第一个）',
                onClick: function () { if (nextProblem !== null) setUpto(nextProblem) },
              }, '恶点▶'),
              React.createElement('input', {
                type: 'range', min: 0, max: total, value: cur,
                title: '拖动快速定位',
                onChange: function (event) { setUpto(Number(event.target.value)) },
              }),
            ),
            React.createElement('div', { className: 'dgs-note' },
              problem !== null
                ? React.createElement('span', null,
                    React.createElement('span', { className: 'dgs-prob' },
                      '○ 实战 ' + String(problem.moveNumber) + ' 手 ' + String(problem.coordLabel || '')),
                    hint && hint.label
                      ? React.createElement('span', null,
                          '　',
                          React.createElement('span', { className: 'dgs-rec' }, '◌ AI 首选 ' + String(hint.label)),
                          hint.winratePct == null ? '' : '（胜率 ' + String(hint.winratePct) + '%）',
                          pvPoints.length > 1
                            ? ' → ' + problem.pv.slice(1).map(function (p) { return String(p && p.label ? p.label : '') })
                                .filter(function (t) { return t !== ''; }).join(', ')
                            : '')
                      : null)
                : problemMarks.length > 0
                  // 没停在问题手上时，说明盘上那些小色点是什么（否则用户不知道能看什么）
                  ? React.createElement('span', null,
                      React.createElement('span', { className: 'dgs-prob' }, '● 盘上色点＝问题手'),
                      '（共 ' + problemMarks.length + ' 处，紫＞红＞橙）　点列表任意一行跳到那一手')
                  : '点棋盘交叉点可就该点提问；「▸」把棋盘收起来',
            ),
          )
          kids.push(React.createElement('div', { className: 'dgs-split', key: 'split' }, boardCol,
            React.createElement('div', { className: 'dgs-col-list' }, listEl)))
        } else {
          kids.push(listEl)
        }
      }

      return React.createElement('div', { 'data-dgs': '' }, head,
        React.createElement('div', null, kids))
    }

    /** 注册到 composer dock 与左侧栏面板位；React/slots 缺席时静默跳过。 */
    function registerPanel(ctx) {
      if (React === null || typeof React.createElement !== 'function') return
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      ensureStyles()
      // ① 输入框下方的面板：负责读取棋谱、插入追问（只有 composer 系列插槽给 inputActions）
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'go-sensei-panel' },
          SenseiPanel,
        )
      })
      // ② 左侧栏的「Sensei 棋盘」图标位：外壳自己渲染按钮与标签、自己负责切主区域，
      //    我们只画图标 —— 这样不会和原生侧边栏抢位置（叠加式注册，replaceRisk 为 none）
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: 'Sensei 棋盘' },
          SenseiPanelIcon,
        )
      })
      // ③ 对应的主区域面板：棋盘在左、问题手详细说明在右（keyed 插槽，新 key 不覆盖 conversation）
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: PANEL_ID }, SenseiBoardPage)
      })
    }

    // -----------------------------------------------------------------------
    // 右侧栏：为 .sgf 注册一个原生「文档」预览实现
    //
    // 平台事实（读 dsh-client-ui-sidebar-documentpreview 的产物确认，第三方插件
    // 唯一能进右侧栏的正路 —— 侧栏标签页的创建是外壳内部的东西，插件开不了）：
    //   · ctx.documentPreviews.register({ id, extensions, priority, title, loading, wrap })
    //     匹配规则：priority !== 'builtin' 属"外部档"排前，然后比最长后缀，再按注册顺序；
    //     .sgf 没有内置实现抢，所以这一条会胜出。
    //   · 正文注册进 sidebar.right.tab.document，key = 定义的 id；
    //     props 给 { resourceAddress, content, wrap, scrollportRef, useTabInfo }，
    //     其中 resourceAddress 形如 dsh-resource://file/session/<会话>/<路径>。
    // 于是：在对话里点文件的「打开」（或文件列表里点开 .sgf）→ 棋盘出现在右侧栏，
    // 对话留在左边。这正是"左右排版"的原生做法，不遮挡任何原生控件。
    // -----------------------------------------------------------------------

    /** 右侧栏文档正文的注册 key（与文档预览定义的 id 同一个值）。 */
    var DOC_BODY_ID = 'dsh-go-sensei/board'

    /**
     * dsh-resource 文件地址 → 会话 id。
     * 右侧栏文档给的是会话内相对路径，宿主得靠这个 id 反查工作区根才能解析
     * （客户端没有会话 cwd）。
     * @param {string} address 形如 dsh-resource://file/session/<id>/<路径>
     * @returns {string} 会话 id；不是会话文件地址时返回空串
     */
    function sessionIdOfAddress(address) {
      var prefix = 'dsh-resource://file/'
      var text = String(address == null ? '' : address)
      if (text.indexOf(prefix) !== 0) return ''
      var end = text.search(/[?#]/)
      var parts = text.slice(prefix.length, end === -1 ? undefined : end).split('/')
      if (parts[0] !== 'session') return ''
      var id = parts[1]
      if (id === undefined || id === '') return ''
      try {
        return decodeURIComponent(id)
      } catch (error) {
        return id
      }
    }

    /**
     * dsh-resource 文件地址 → 文件路径。
     * 与官方 parseFileAddress 同规则：前缀 20 字符，第二段是 scope，
     * 第三段是会话 id，其余各段解码后用 '/' 拼回路径（Windows 盘符是一段，如 'C:'）。
     * @param {string} address 形如 dsh-resource://file/session/<id>/C:/dir/a.sgf
     * @returns {string} 文件路径；不是会话文件地址时返回空串
     */
    function filePathOfAddress(address) {
      var prefix = 'dsh-resource://file/'
      var text = String(address == null ? '' : address)
      if (text.indexOf(prefix) !== 0) return ''
      var end = text.search(/[?#]/)
      var parts = text.slice(prefix.length, end === -1 ? undefined : end).split('/')
      if (parts[0] !== 'session') return ''
      var segments = parts.slice(2)
      if (segments.length === 0) return ''
      var decoded = []
      for (var i = 0; i < segments.length; i++) {
        try {
          decoded.push(decodeURIComponent(segments[i]))
        } catch (error) {
          decoded.push(segments[i])
        }
      }
      return decoded.join('/')
    }

    /**
     * 右侧栏文档正文：一块纵向排布的棋盘（棋盘在上、问题手列表在下）。
     * 与输入框下方那块不同，这里没有 inputActions，所以点行改为复制追问语。
     */
    function SenseiDocumentBody(props) {
      var path = filePathOfAddress(props && props.resourceAddress)
      var sessionId = sessionIdOfAddress(props && props.resourceAddress)
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var uptoState = React.useState(0)
      var upto = uptoState[0]
      var setUpto = uptoState[1]
      var followState = React.useState(true)
      var follow = followState[0]
      var setFollow = followState[1]
      var copiedState = React.useState('')
      var copied = copiedState[0]
      var setCopied = copiedState[1]

      React.useEffect(function () {
        if (path === '') return undefined
        var alive = true
        setBusy(true); setErr(''); setData(null); setUpto(0)
        // 带上会话 id：文档地址里的路径是会话内相对路径，宿主靠这个反查工作区根
        fetch('/go-sensei/review?path=' + encodeURIComponent(path)
          + (sessionId ? '&session=' + encodeURIComponent(sessionId) : ''))
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (!alive) return
            setBusy(false)
            if (!body || body.ok !== true) {
              setErr(body && body.error ? String(body.error) : '读取失败')
              return
            }
            var next = body.data
            var board = next && next.board && Array.isArray(next.board.moves) ? next.board : null
            var total = board === null ? 0 : board.moves.length
            var list = next && Array.isArray(next.candidates) ? next.candidates : []
            var worst = list.length > 0 && typeof list[0].moveNumber === 'number' ? list[0].moveNumber : 0
            setData(next)
            setUpto(worst > 0 ? Math.min(worst, total) : total)
          })
          .catch(function (error) {
            if (!alive) return
            setBusy(false); setErr(String(error && error.message ? error.message : error))
          })
        return function () { alive = false }
      }, [path])

      function pollFocusDoc() {
        fetch('/go-sensei/focus')
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            var f = body && body.ok === true ? body.focus : null
            if (!f || typeof f.seq !== 'number') return
            if (f.seq > focusPointer.seen) focusPointer.seen = f.seq
            if (f.seq <= focusPointer.seq) return
            focusPointer.seq = f.seq
            if (path !== '' && sameFile(path, f.path || f.name || '')) {
              if (typeof f.moveNumber === 'number' && f.moveNumber > 0) setUpto(f.moveNumber)
            }
          })
          .catch(function () { /* 轮询失败静默重试 */ })
      }

      React.useEffect(function () {
        if (!follow || path === '') return undefined
        var timer = setInterval(pollFocusDoc, 3000)
        pollFocusDoc()
        return function () { clearInterval(timer) }
      }, [follow, path])

      function copyFollowUpDoc(candidate) {
        var text = followUpText(candidate, path)
        var done = function () { setCopied('已复制第 ' + candidate.moveNumber + ' 手的追问语') }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { setCopied('复制失败：请手动选中') })
            return
          }
        } catch (error) {
          /* 无剪贴板权限：退回提示 */
        }
        setCopied('复制失败：请手动选中')
      }

      if (path === '') {
        return React.createElement('div', { className: 'dgs-doc' },
          React.createElement('div', { className: 'dgs-sub' }, 'Sensei 棋盘：这个标签页的文件地址无法解析。'))
      }

      var board = data && data.board && Array.isArray(data.board.moves) ? data.board : null
      var total = board === null ? 0 : board.moves.length
      var cur = Math.max(0, Math.min(upto, total))
      var curMove = board !== null && cur > 0 ? board.moves[cur - 1] : null
      var list = data && Array.isArray(data.candidates) ? data.candidates : []
      var problem = null
      for (var i = 0; i < list.length; i++) {
        if (list[i].moveNumber === cur) { problem = list[i]; break }
      }
      var hint = problem && problem.pv && problem.pv[0] ? problem.pv[0] : null
      var pvPoints = board === null || problem === null || !Array.isArray(problem.pv)
        ? []
        : problem.pv.slice(0, 3).map(function (p) { return parsePointLabel(p && p.label, board.size) })
      var problemPoint = problem !== null && curMove !== null && curMove.x >= 0
        ? { x: curMove.x, y: curMove.y, key: problem.labelKey, label: problem.label }
        : null
      var problemMoves = list.map(function (c) { return c.moveNumber }).filter(function (n) {
        return typeof n === 'number'
      }).sort(function (a, b) { return a - b })

      function jumpProblem(direction) {
        if (problemMoves.length === 0) return
        var target = null
        var k
        if (direction > 0) {
          for (k = 0; k < problemMoves.length; k++) {
            if (problemMoves[k] > cur) { target = problemMoves[k]; break }
          }
          if (target === null) target = problemMoves[0]
        } else {
          for (k = problemMoves.length - 1; k >= 0; k--) {
            if (problemMoves[k] < cur) { target = problemMoves[k]; break }
          }
          if (target === null) target = problemMoves[problemMoves.length - 1]
        }
        setUpto(target)
      }

      var kids = [
        React.createElement('div', { className: 'dgs-doc-head', key: 'h' },
          React.createElement('span', { className: 'dgs-title' }, 'Sensei 棋盘'),
          React.createElement('span', { className: 'dgs-sub' }, baseName(path)),
          React.createElement('span', { className: 'dgs-spacer' }),
          React.createElement('button', {
            className: 'dgs-follow',
            title: '开启后：Sensei 在对话里讲到第几手，这里就跟到第几手',
            onClick: function () { setFollow(!follow) },
          }, follow ? '跟随讲解 ✓' : '跟随讲解 ✕'),
        ),
      ]
      if (busy) kids.push(React.createElement('div', { className: 'dgs-sub', key: 'b' }, '读取中…'))
      if (err) kids.push(React.createElement('div', { className: 'dgs-err', key: 'e' }, err))
      if (copied) kids.push(React.createElement('div', { className: 'dgs-ok', key: 'c' }, copied))

      if (board !== null) {
        kids.push(React.createElement('div', { className: 'dgs-doc-status', key: 's' },
          boardStatusText(board, cur, curMove),
          data.mode === 'analysis' ? ' · AI 分析' : ' · 纯棋理'))
        kids.push(React.createElement('div', { className: 'dgs-doc-board', key: 'bd' },
          renderBoard({
            board: board,
            upto: cur,
            problem: problemPoint,
            pv: pvPoints,
            hintLabel: hint && hint.label ? hint.label : '',
          })))
        kids.push(React.createElement('div', { className: 'dgs-ctl', key: 'ctl' },
          React.createElement('button', { onClick: function () { setUpto(0) }, title: '回到开局' }, '⏮'),
          React.createElement('button', { onClick: function () { setUpto(Math.max(0, cur - 1)) }, title: '上一手' }, '◀'),
          React.createElement('button', { onClick: function () { setUpto(Math.min(total, cur + 1)) }, title: '下一手' }, '▶'),
          React.createElement('button', { onClick: function () { setUpto(total) }, title: '跳到末手' }, '⏭'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: problemMoves.length === 0,
            onClick: function () { jumpProblem(-1) }, title: '上一处问题手',
          }, '◀恶点'),
          React.createElement('button', {
            className: 'dgs-jump', disabled: problemMoves.length === 0,
            onClick: function () { jumpProblem(1) }, title: '下一处问题手',
          }, '恶点▶'),
          React.createElement('input', {
            type: 'range', min: 0, max: total, value: cur,
            onChange: function (event) { setUpto(Number(event.target.value)) },
          })))
        if (problem !== null) {
          kids.push(React.createElement('div', { className: 'dgs-note', key: 'n' },
            React.createElement('span', { className: 'dgs-prob' },
              '○ 实战 ' + String(problem.moveNumber) + ' 手 ' + String(problem.coordLabel || '')),
            hint && hint.label
              ? React.createElement('span', { className: 'dgs-rec' }, '　◌ AI 首选 ' + String(hint.label)
                  + (hint.winratePct == null ? '' : '（胜率 ' + String(hint.winratePct) + '%）'))
              : null))
        }
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'm' },
          String(data.moveCount || 0) + ' 手 · ' + list.length + ' 个问题手'
          + (data.autoEngine ? ' · 引擎补算 ' + String(data.autoEngine.moves ?? '') + ' 手' : '')))
        kids.push(React.createElement('div', { className: 'dgs-list dgs-doc-list', key: 'list' },
          list.map(function (candidate, index) {
            var top = candidate.pv && candidate.pv[0] ? candidate.pv[0] : null
            return React.createElement('button', {
              className: 'dgs-item',
              key: String(candidate.moveNumber) + '-' + index,
              title: '点击：棋盘跳到这一手，并复制追问语',
              onClick: function () {
                setUpto(candidate.moveNumber)
                copyFollowUpDoc(candidate)
              },
            },
              React.createElement('div', { className: 'dgs-l1' },
                React.createElement('span', { className: 'dgs-mv' }, '第 ' + candidate.moveNumber + ' 手'),
                React.createElement('span', null, candidate.color === 'B' ? '黑' : '白'),
                React.createElement('span', { className: 'dgs-coord' }, candidate.coordLabel || candidate.coord || ''),
                React.createElement('span', {
                  className: 'dgs-badge',
                  style: { color: severityColor(candidate.label) },
                }, candidate.label || '')),
              React.createElement('div', { className: 'dgs-l2' },
                '−' + (candidate.winrateLoss == null ? '?' : candidate.winrateLoss) + '% 胜率'
                + (candidate.scoreLoss == null ? '' : ' / ' + candidate.scoreLoss + ' 目')
                + (top && top.label ? ' · AI 首选：' + top.label : '')))
          })))
      } else if (!busy && err === '') {
        kids.push(React.createElement('div', { className: 'dgs-sub', key: 'w' }, '正在准备棋盘…'))
      }
      return React.createElement('div', { className: 'dgs-doc', 'data-dgs': '' }, kids)
    }

    /**
     * 注册 .sgf 的文档预览实现（右侧栏）。
     *
     * 用 ctx.inject 等 documentPreviews 出现再注册，而不是一开始就 ctx.get：
     * 客户端服务按挂载顺序出现，本插件的 apply 完全可能早于提供该服务的官方
     * 文档预览包 —— 早一步 get 就是 undefined，注册会被静默跳过（真机实测踩过：
     * 产物里有代码、右侧栏却仍是纯文本预览）。
     * 无 inject 的极简上下文（单测桩）退回即时 get。
     */
    function registerDocumentPreview(ctx) {
      if (React === null || typeof React.createElement !== 'function') return
      var mount = function (scoped) {
        var host = scoped === undefined ? ctx : scoped
        var documents = host.get('documentPreviews')
        if (documents === undefined || typeof documents.register !== 'function') return
        var slots = host.get('slots')
        if (slots === undefined || typeof slots.register !== 'function') return
        ensureStyles()
        var definition = {
          id: DOC_BODY_ID,
          extensions: ['sgf'],
          // 非 'builtin' 即"外部档"：比内置兜底优先，且 .sgf 没有内置实现抢
          priority: 'external',
          title: function () { return 'Sensei 棋盘' },
          loading: 'text-pages',
          wrap: false,
        }
        if (typeof host.effect === 'function') host.effect(function () { return documents.register(definition) })
        else documents.register(definition)
        slots.inject('sidebar.right.tab.document', function () {
          return slots.register({ name: 'sidebar.right.tab.document', key: DOC_BODY_ID }, SenseiDocumentBody)
        })
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['documentPreviews'], function (scoped) { mount(scoped) })
        return
      }
      mount(undefined)
    }

    exports.name = 'dsh-go-sensei'
    // 两个都是**软**依赖：缺席时各自静默降级，不做硬注入（否则整包永久 pending）。
    exports.inject = []
    exports.apply = function apply(ctx) {
      try {
        registerPanel(ctx)
      } catch (error) {
        // 面板注册失败绝不能影响插件其余部分（工具与服务端半照常工作）
      }
      try {
        registerDocumentPreview(ctx)
      } catch (error) {
        // 右侧栏预览注册失败同样不能影响面板与工具
      }
    }
    // 棋盘规则是纯函数，但只存在于这个单文件 bundle 里（浏览器半零构建、无模块系统），
    // 所以显式暴露给单测：React 桩只能验证"渲染出了什么"，验证不了提子算得对不对。
    // 生产路径不读它，宿主 Client 装载器也只认 name/inject/apply。
    exports.__internals = {
      boardLabel: boardLabel,
      parsePointLabel: parsePointLabel,
      groupAt: groupAt,
      playStone: playStone,
      boardAt: boardAt,
      starPoints: starPoints,
      baseName: baseName,
      filePathOfAddress: filePathOfAddress,
      sameFile: sameFile,
      renderBoard: renderBoard,
      focusPointer: focusPointer,
      // 两份 UI 的共享状态：单测直接摆好它再渲染整页棋盘
      //（React 桩把 useEffect 实现成空操作，所以发布/订阅在测试里不参与）
      senseiStore: senseiStore,
      senseiPatch: senseiPatch,
      PANEL_ID: PANEL_ID,
    }
    return module.exports
  },
})
