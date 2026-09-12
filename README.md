# dsh-go-sensei —— DeepGo Sensei 围棋复盘教练

DSH（DeepSeek Harness）插件：把围棋 AI 的数学判断（胜率、目差、候选点、变化图）翻译成**老师级口头讲解**，供自学棋手复盘。讲解由 `go_write_review` 写回 SGF 的 `C[]` 注释，Lizzieyzy 打开即可显示。

**架构一句话**：插件自己**从不运行 Lizzieyzy**，只在需要补算时启动 `katago.exe`；它与 Lizzieyzy 的全部往来都通过 **SGF 文件**。

## 它启动什么、不启动什么

这是本项目最容易误解的地方，先说清楚：

| 组件 | 出现在哪个环节 | 是本插件启动的吗 |
|---|---|---|
| `katago.exe analysis` | 棋谱无分析数据且你配置了 `kataGoPath` 时，补算问题手 | ✅ 是（**唯一**被 spawn 的进程） |
| Lizzieyzy | ① 你在它里面手动分析并保存 SGF；② 打开写回注释后的棋谱查看讲解 | ❌ 否，两步都是**你自己**在用它 |
| Java / JRE / `.jar` | — | ❌ 完全没有（全项目 0 处调用） |

- 唯一被 spawn 的命令行（`src/engine.js`）：

  ```
  katago.exe analysis [-config <cfg>] [-model <model>] -override-config numAnalysisThreads=1
  ```

  JSON 查询走 stdin、JSON 结果走 stdout；工作目录设为 `katago.exe` 所在目录。
- 插件与 Lizzieyzy 之间**只经 SGF 文件交互**：读它保存的 `LZ[]` / `C[]` 分析，写回它能显示的 `C[]` 注释。不链接、不合并、不修改其源码。
- 配置示例里的 `kataGoPath` 常指向 `...\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\katago.exe`，看着像"依赖 Lizzieyzy"，其实那只是**便携包恰好把独立的 `katago.exe` 放在了那里**。插件要的只是那个 exe，与 Lizzieyzy 本体（`lizzie-yzy*.jar` + JRE）毫无关系。

## 前置条件

### 必需

| 项 | 要求 | 说明 |
|---|---|---|
| DSH | 能跑 `dsh web` | 工具、人设段、客户端面板都挂在 DSH 上 |
| Node.js | **>= 22.19** | 见 `package.json` 的 `engines`（本机实测 v24.19.0） |

依赖只有 3 个纯 JS 包（`@deepseek-ai/schemastery`、`@sabaki/sgf`、`iconv-lite`），`npm install` 即可，**无编译步骤**。

### 可选 A：KataGo —— 只有"补算"才需要

- **需要它**：手里的 SGF 没有 AI 分析数据，你想让插件自己算出问题手。
- **不需要它**：棋谱是在 Lizzieyzy 里分析过再保存的（带 `LZ[]`）。此时 `kataGoPath` 留空即可，**零引擎依赖**。

需要备齐三样，缺一不可：

1. **`katago.exe`** —— 版本 **v1.14 以上**（v1.14 起 analysis 模式默认 JSON 协议；本机实测 v1.16.4）。
2. **模型权重** —— 如 `kata1-b18c384nbt-…bin.gz`（约 98 MB）。
3. **带 analysis 键的配置文件** —— 必须是 analysis 配置，**不能**拿 GTP 配置顶替。`analysis_example.cfg` 里的关键键：

   ```ini
   reportAnalysisWinratesAs = BLACK   # 胜率视角；插件会读这一个键做口径换算
   numAnalysisThreads = 2             # 插件额外用 -override-config 覆盖为 1
   maxVisits = 500                    # 插件查询自带 maxVisits，以插件配置 maxVisits 为准
   logDir = analysis_logs
   ```

⚠️ **三个实测最容易翻车的点**

- **不能只拷 `katago.exe`**：它依赖同目录的 11 个 DLL（`libcrypto-3-x64.dll`、`libssl-3-x64.dll`、`libz.dll`、`libzip.dll`、`msvcp140*.dll`、`vcruntime140*.dll`）。要么整个 `engine_18b` 目录一起拷，要么直接用现成便携包。
- **后端必须匹配你的机器**：`katago.exe` 分 OpenCL / CUDA / Eigen（纯 CPU）/ TensorRT 等版本，选错会启动即失败。本机用的是 **OpenCL** 版（要求显卡驱动带 OpenCL）。
- **别指向 GTP 配置**：Lizzieyzy 的 `myconfig.cfg` 里 `reportAnalysisWinratesAs` 是**被注释掉的**，它属于 GTP 配置；拿它启动 analysis 模式会缺键报错。用引擎目录自带的 `analysis_example.cfg`，模型另用 `-model` 指定。

**获取途径（二选一）**

- **官方 release**：从 [KataGo releases](https://github.com/lightvector/KataGo/releases) 下载对应后端的可执行文件，从 [katagotraining.org](https://katagotraining.org/) 下载 `.bin.gz` 权重，配置文件用仓库里的 `cpp/configs/analysis_example.cfg`。
- **复用现成便携包**（本机走的就是这条）：Lizzieyzy-KataGo-Portable 类整合包里的 `engine_18b\` 已备齐 exe + DLL + 模型 + `analysis_example.cfg`，直接把这个目录填进下面三个配置项即可。**注意这只是"借用它的引擎目录"，插件不会启动 Lizzieyzy。**

**验证引擎可用**

```bash
# 能打印版本与后端即正常（本机实测：KataGo v1.16.4 / Using OpenCL backend）
<你的路径>\katago.exe version
```

### 可选 B：Lizzieyzy —— 只有这两件事需要它

1. **产出带分析的棋谱**：走"消费现成分析谱"这条路时，在它里面分析棋局并在保存时**勾选保存分析数据**（写入 `LZ[]`）。
2. **查看写回的讲解**：`go_write_review` 写入的 `C[]` 注释由 Lizzieyzy 原生显示。

插件**不依赖**它运行：不装 Lizzieyzy，只要有棋谱文件，纯棋理复盘（theory 模式）照样能用。

## 安装

```bash
# 本地目录开发/试用
dsh plugin --profile web add ./dsh-go-sensei

# 发布后
dsh plugin --profile web add dsh-go-sensei
```

重启 `dsh web` 后生效。验证：

```bash
dsh --profile web --dump-config | grep -A2 go-sensei
```

Web 页面右下角出现「DeepGo Sensei · 复盘教练」浮动面板即客户端加载成功；卸载插件后面板与样式无残留。

## 配置（全部可选，不配也能用）

| 配置项 | 默认 | 作用 |
|---|---|---|
| `level` | `auto` | 讲解难度 `18K`…`9D`，或 `auto`（按棋谱双方段位自适应） |
| `winrateThreshold` | `0.03` | 问题手胜率落差阈值（0~1 小数） |
| `scoreThreshold` | `3` | 问题手目差阈值（目） |
| `maxCandidates` | `10` | 每次复盘返回的候选上限 |
| `pvDepth` | `6` | 每条候选变化图的 PV 截断手数 |
| `tokenBudget` | `50000` | 单局讲解 token 预算（写进人设段的软约束） |
| `kataGoPath` | `''` | `katago.exe` 路径。**留空 = 不注册 `go_engine_analyze`、也不自动补算**（纯消费 SGF 模式） |
| `kataGoConfig` | `''` | analysis 配置文件路径（可选） |
| `kataGoModel` | `''` | 模型权重路径（可选，覆盖配置里的 `modelFile`） |
| `maxVisits` | `100` | 补算每手搜索量（越大越准越慢） |

在 profile 的 `cordis.patch.yml`（或插件行）里覆盖：

```yaml
- id: go-sensei
  config:
    level: auto            # 18K..9D | auto（按棋谱双方段位自适应）
    winrateThreshold: 0.03 # 问题手胜率落差阈值（0~1）
    scoreThreshold: 3      # 问题手目差阈值（目）
    maxCandidates: 10      # 每次复盘返回的候选上限
    pvDepth: 6             # 变化图 PV 截断手数
    tokenBudget: 50000     # 单局讲解 token 预算（软约束）
    kataGoPath: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\katago.exe
    kataGoConfig: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\analysis_example.cfg
    kataGoModel: C:\AI_GO-main\Lizzieyzy-KataGo-Portable_v1.1\engine_18b\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz
    maxVisits: 100         # KataGo 每手搜索量
```

> 上面三条引擎路径看着像"在调 Lizzieyzy"，实际只是那个**独立的 `katago.exe` 恰好住在便携包的 `engine_18b` 目录里**。换成任何其他目录下的 katago.exe 一样可用，插件不关心它从哪来。

## 数据从哪来（两条路径）

**路径 ①：消费现成分析谱（零引擎依赖）**
你在 Lizzieyzy 里分析并保存 SGF，插件读它的分析数据。解析通道共三条：KataGo 属性（`WV`/`DM`/`PV`）、Lizzieyzy 属性（`LZ`/`LZOP`）、以及 `C[]` 注释文本（`Move <N> 黑胜率: x% (±y%) (引擎 / 计算量)` 格式，实测 Lizzieyzy 2.5.3）。

**路径 ②：插件自起 KataGo 补算**
棋谱**完全没有**分析数据、且同时满足下列条件时，`go_review_moves` 与客户端面板会**自动补算**，不需要你手动调工具：

- `kataGoPath` 已配置；
- 棋谱无任何分析数据（只要有一手带分析就不触发）；
- 棋盘是 **19 路**。

补算失败**不阻断**复盘：自动降级为 theory 模式，并把失败原因如实带回（如 `subprocess` 服务不可用、引擎退出码非 0、查询被引擎拒绝）。

**两者都没有时**：走 **theory 模式** —— 纯棋理讲解，不虚构胜率与变化图。

## 使用流程（与 Lizzieyzy 配合）

1. 在 Lizzieyzy 里分析棋局，`保存` 时勾选保存分析数据（写入 `LZ[]` 与 `C[]` 注释），或直接把野狐/弈城导出的 SGF 放进工作区。
2. 对话里说「复盘这盘棋 <路径>」——插件自动：`go_parse_sgf` 读谱 → `go_review_moves` 找问题手 → 逐手讲解（先问后讲、水平自适应）。
3. 「把讲解写回棋谱」→ `go_write_review` 写入 `C[]` 注释 → Lizzieyzy 打开即可看到讲解。
4. 追问「第 N 手改下 X 会怎样」→ `go_position_context` 提供局面上下文与 AI 候选变化。
5. 「生成报告」→ `go_export_report` 落盘 Markdown（默认与棋谱同名 `.review.md`）。
6. 同一局重复复盘命中同局面哈希缓存（工具返回 `cached: true`，token 消耗显著下降）。

## 客户端面板

Web 页面输入框下方一行（默认折叠）：填 SGF 路径 → 点「读取问题手」→ 列出问题手（第 N 手 / 黑白色 / 坐标 / 标签徽标 / 胜率差 / 目差 / AI 首选）→ **点任意一行把追问语插入输入框**。

- 数据来自 Host 只读路由 `GET /go-sensei/review?path=<sgf>&cwd=<工作区>`，与对话走**同一条管线**（含自动补算），因此面板与对话结果一致。
- 路径被约束在已知工作区根之下（`resolve` 归一化 + `contains` 包含判断），`../` 逃逸会被挡掉；只读、无副作用，故不设令牌。
- 面板是**软依赖**组合：React 或 `slots` 缺席时静默不注册（`inject: []`），绝不因面板问题拖垮工具与服务端。

## 工具一览

| 工具 | 作用 | 前置条件 |
|---|---|---|
| `go_parse_sgf` | 棋谱元信息 + 主变化线手数统计（GBK / 双重 mojibake 自愈解码） | 无 |
| `go_review_moves` | 问题手候选（大恶手/失误/不精确 标签 + 胜率/目差损失 + ≤3 个 AI 候选点，PV 截断、1 位小数） | 无（无分析数据且有引擎时自动补算） |
| `go_position_context` | 某手前后 N 手序列 + 该手候选与 PV（供追问） | 无 |
| `go_write_review` | 讲解写回 SGF `C[]` 注释（默认追加、可覆盖、自动转义；按变化树定位主线，带变化图的棋谱同样可写） | 无（沙箱下需 `sandboxPolicy` 服务，见"已知限制"） |
| `go_export_report` | Markdown 报告落盘（自动骨架或全文）。骨架 = 棋局信息 + 问题手表格 + **从 `C[]` 汇总已写回的逐手讲解**（自动剔除引擎分析行）；`format` 仅支持 `markdown`，其他值报错 | 无 |
| `go_engine_analyze` | 对指定手数区间补算，输出与 `go_review_moves` 同构的候选列表 | **需 KataGo**：`kataGoPath` 留空时不注册此工具 |

## 开发

```bash
npm install
npm test        # node:test 单测（含真实野狐/Lizzieyzy 棋谱夹具）
npm run check   # 语法检查（零构建，纯 JS）

# 无模型演示：对任意 SGF 跑 解析→复盘→写回（写 .demo.sgf 副本，不动原文件）
node scripts/demo.mjs <sgf路径> [起始手] [结束手]
```

`test/engine.test.mjs` 的真机 KataGo 集成测试在本机装有 KataGo 时自动运行（模型加载约 1~2 分钟），
无引擎环境自动跳过。

### 版本与发布

源码仓库：<https://github.com/Zhuang-A/dsh-go-sensei>（`main` 分支，语义化版本 tag）。

```bash
git clone git@github.com:Zhuang-A/dsh-go-sensei.git
cd dsh-go-sensei && npm install && npm test
```

- 改动直接提交到 `main`；发一版时同步改 `package.json` 的 `version` 并打同名 tag（如 `v0.1.0`），`git push --follow-tags`。
- 换行策略见 `.gitattributes`：源码统一 LF（不依赖各机器的 `core.autocrlf`）；`test/fixtures/*.sgf` 标 `-text`，按**字节原样**提交——真实野狐导出的夹具本身是 CRLF，一旦被 EOL 规范化改写，逐字节依赖夹具的解析测试就会失真。
- 不入库：`node_modules/`、`test/tmp-workspace/`、`*.tgz`、`*.demo.sgf`、`*.log`。

### 工具 schema 子集（改 schema 前务必读）

`ctx.tools.register` 会对 `parameters` 与 `output.schema` 跑 `@deepseek-ai/dsh-tools` 的
`assertSupportedJsonSchema`；**不通过就抛错、插件加载中止，`dsh web` 直接起不来**。支持的关键字只有：

`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解类（`description` / `title` / `default` / `examples`）。

三条实测踩过的坑：

1. **`type` 必须是单一类型字符串**，不接受数组。写 `type: ['object','null']` 会报
   `UNSUPPORTED_SCHEMA`（本插件确实由此导致过一次启动失败）。可选字段请**省略该键**而不是给 `null`。
2. 除上述白名单外的任何关键字都会被拒（如 `pattern` / `minimum` / `format`）。
3. `type` 与 `oneOf` 不能同时出现；`oneOf` 至少要两项。

`test/schema.test.mjs` 直接 import 运行时校验器，对**每个工具的 parameters 与 output.schema**
逐条断言，并显式禁止 `type` 数组——改 schema 后跑 `npm test` 即可拦住这类启动级故障。

## 常见问题

- **面板没出现**：确认 `--dump-config` 里有 go-sensei 层，且重启过 `dsh web`；卸载插件需重启页面才消失。
- **野狐棋谱棋手名乱码**：文件是 GBK/双重 mojibake 编码，插件自动解码并在可无损回修时修复；个别字符已损坏时保留原文并给出 warning（不影响棋谱分析）。
- **Lizzieyzy 保存的 SGF 没有分析数据**：Lizzieyzy 需在保存时勾选「保存分析数据」（写入 `LZ[]`）；否则插件走纯棋理模式，或配置 KataGo 后用 `go_engine_analyze` 补算（有引擎时也会自动补算）。
- **KataGo 报 `Could not find key`**：你指向了 GTP 配置（缺 analysis 键）。改用 `analysis_example.cfg`，或加 `-override-config numAnalysisThreads=1`。
- **KataGo 报 `Must be a integer or half-integer from -150.0 to 150.0`（`field` 却写着 `rules`）**：这是**贴目**超范围/非半整数，不是规则字符串的问题（KataGo v1.16.4 实测会把 field 误标为 `rules`）。插件已对 `KM[]` 做就近吸附到 0.5 倍数并夹到 `[-150, 150]`；若仍触发，检查棋谱的 `KM[]` 是否异常。
- **token 花费**：单局默认预算 5 万 token 软约束；数据裁剪（每手 ≤3 候选、PV 截断、1 位小数）+ 懒生成 + 同局面缓存；批量生成报告建议安排在 DeepSeek 闲时（高峰 9:00–12:00 / 14:00–18:00 涨价）。

## 已知限制与后续工作

- `go_write_review` 用 `@sabaki/sgf` 解析变化树定位主线后**重新序列化**输出：手数、旁支、属性集合与原有注释全部保留（实测 106 手 Lizzieyzy 分析谱写回后 106 手 / 2 个变化图不变），但**原文件的排版与逐字节格式不再保留**（输出统一 UTF-8，缩进规范化）。若需保留原始字节排版，请在写回前备份棋谱。
- 写入依赖 `ctx.sandboxPolicy` 解析出的 `SandboxExecutionPolicy`（作为 `fs.writeText` 第 5 参数）。该服务是**可选读取**，未挂载时不阻止加载，但沙箱后端下写入会被拒并给出 `file access denied` 警告。
- **补算仅支持 19 路**（`go_engine_analyze` 与自动补算同此限制）；让子棋谱支持 **2~9 子**（标准摆点表），更多子数会明确报错。
- **补算规则不是固定中国规则**：插件按 SGF 的 `RU[]` 判断——含 `japan` 用 `japanese`，其余一律 `chinese`。贴目取自 SGF `KM[]`，并吸附到 0.5 的整数倍、夹到 `[-150, 150]`。
- **补算胜率视角取决于引擎配置**：插件读 `kataGoConfig` 文本里的 `reportAnalysisWinratesAs` 做口径换算；读不到时按 KataGo 默认（SELF = 行棋方视角）。本机 `analysis_example.cfg` 实测为 `BLACK`。改了引擎配置会让同一棋谱的胜率数字变化，属预期。
- `test/engine.test.mjs` 的真机集成测试需要能启动子进程：受限沙箱下 `spawnSync` 会返回 `EPERM`，测试会静默跳过（`KATAGO_PATH` 已设置也会跳过）。本机 KataGo v1.16.4 实测通过，单次补算约 3.8 秒。
- 报告骨架靠**整行模式匹配**区分"引擎分析行"与"人写的讲解"（判别式见 `extractUserNotes`）。若某种导出器的分析行格式不同，可能被当成讲解收进报告；宁可多留也不误删，导出后扫一眼即可。
- **客户端面板的实现要点**（`conversation.composer.dock`，功能见上文「客户端面板」）：
  - 注册在 composer dock 而非 `shell.overlay`：只有 `conversation.composer.*` 系列的标准 props 提供 `inputActions`（`shell.overlay` 只给 `useSessions`/`usePanelInfo` 等），而插入输入框必须用它。
  - 数据来自 Host 路由 `GET /go-sensei/review?path=<sgf>&cwd=<工作区>`（同源 fetch）。绕服务端的原因：客户端插件**拿不到工具的 execute**（Host 工具面只暴露 `register`/`schemas`/`get`），也无法直接读盘；由拥有 `ctx.fs` 与 `reviewGame` 的宿主读盘算好、回裁剪后的 JSON。该路由只读无副作用，`cwd` 由面板从会话快照带出以解析相对路径。
  - 浏览器端拿不到会话 cwd，因此 Host 侧把历次 `go_*` 工具调用所用的工作区根记下来，作为相对路径的解析基准（另有深度 3 / 400 节点的**有界**文件名发现兜底）。

## 许可

MIT。与 Lizzieyzy（GPL-3.0）仅经 SGF 文件交互，不链接、不合并其代码。
