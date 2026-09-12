// scripts/puppeteer-panel-shot.cjs
// DeepGo Sensei —— 客户端浮动面板「模拟点击 + 截图」验证工具（供未受限环境使用）
//
// 前置：npm i -D puppeteer-core          （需网络；连系统 Chrome，不下载浏览器）
// 运行：node scripts/puppeteer-panel-shot.cjs
// 输出：shots/panel-{initial,collapsed,click-review,click-ask,disposed}.png
//
// 说明：本脚本自包含（内联 client.js 源码 + __ModuleLoader__ + .dsw-* 主题变量），
//       用真实浏览器渲染面板并依次模拟 折叠/展开/复盘按钮/追问按钮/dispose 等点击，
//       每步落一张截图。仅需系统 Chrome，无其它依赖。
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const path = require('path')

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')
const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots')
const EXE = process.env.CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'

const CSS_VARS = {
  '--dsw-specific-menu': '#191b21',
  '--dsw-alias-border-inverted': 'rgba(255,255,255,0.10)',
  '--dsw-shadow-lv3': '0 8px 30px rgba(0,0,0,0.55)',
  '--dsw-font-family': 'system-ui',
  '--dsw-alias-label-primary': '#e8eaf0',
  '--dsw-alias-label-secondary': '#adb5c5',
  '--dsw-alias-label-tertiary': '#7b8494',
  '--dsw-alias-success': '#3fb950',
  '--dsw-alias-warning': '#d29922',
}

function buildHtml() {
  const vars = Object.entries(CSS_VARS).map(([k, v]) => `r.style.setProperty('${k}', '${v}');`).join('')
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#0f1115;color:#e8eaf0;font-family:system-ui}</style>
</head><body>
<script>
window.__ModuleLoader__ = { load: function (entry) { var p = entry.factory(); window.__dispose = p.apply(); window.__loadedId = entry.id; } };
(function () { var r = document.documentElement; ${vars} });
</script>
<script>${CLIENT_SRC}</script>
</body></html>`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 780, deviceScaleFactor: 1 })

  await page.setContent(buildHtml(), { waitUntil: 'load' })
  await page.waitForSelector('[data-dsh-go-sensei]')
  fs.mkdirSync(OUT, { recursive: true })

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') })

  // 1) 初始·展开
  await shot('panel-initial')

  // 2) 点击折叠 toggle -> 收起
  await page.click('[data-dsh-go-sensei] .dgs-toggle')
  await sleep(250)
  await shot('panel-collapsed')

  // 3) 再点 -> 展开
  await page.click('[data-dsh-go-sensei] .dgs-toggle')
  await sleep(250)

  // 4) 点击「复盘这盘棋」-> 复制快捷语 -> 提示行闪烁
  await page.evaluate(() => {
    [...document.querySelectorAll('[data-dsh-go-sensei] .dgs-btn')]
      .find((b) => b.textContent.includes('复盘这盘棋')).click()
  })
  await sleep(350)
  await shot('panel-click-review')

  // 5) 填手数后点击「追问这手」
  await page.evaluate(() => { document.querySelectorAll('[data-dsh-go-sensei] .dgs-input')[1].value = '21' })
  await page.evaluate(() => {
    [...document.querySelectorAll('[data-dsh-go-sensei] .dgs-btn')]
      .find((b) => b.textContent.includes('追问这手')).click()
  })
  await sleep(350)
  await shot('panel-click-ask')

  // 6) 卸载 dispose -> 面板与样式应无残留
  await page.evaluate(() => window.__dispose())
  await sleep(250)
  const residue = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-dsh-go-sensei]'),
    style: !!document.getElementById('dsh-go-sensei-style'),
  }))
  await shot('panel-disposed')

  console.log('dispose residue =', JSON.stringify(residue))
  console.log('screenshots ->', OUT)
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
