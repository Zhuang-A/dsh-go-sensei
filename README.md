# dsh-go-sensei —— DeepGo Sensei 围棋复盘教练

给 DSH（DeepSeek Harness）装一位围棋老师。把手上一盘棋的 SGF 棋谱交给它，它会像陪练老师那样逐手讲给你听：这手棋原本想干什么、问题出在哪、改下哪里会更好。讲完可以把讲解写回棋谱文件，也可以导出一份 Markdown 复盘报告。

- **有棋谱就能用**：棋谱里没有 AI 分析数据、你也没装任何围棋软件，照样能讲——这一档只讲棋理，不报胜率。
- **想听 AI 的判断**（胜率、目差、AI 推荐点、变化图）：在本机装一次 [KataGo](https://github.com/lightvector/KataGo)（免费开源），插件会自动调用它补算，不需要你手动敲命令。
- **不需要 Java，也不需要别的围棋软件。** KataGo 是唯一可能被插件启动的外部程序，而且只在你把它的路径填进配置之后。

---

## 目录

- [它能帮你做什么](#它能帮你做什么)
- [5 分钟上手](#5-分钟上手)
- [接入 DSH：安装、验证、卸载](#接入-dsh安装验证卸载)
- [配置项](#配置项)
- [装一次 KataGo，让讲解带上 AI 数字](#装一次-katago让讲解带上-ai-数字)
- [棋谱要求（SGF 格式）](#棋谱要求sgf-格式)
- [棋谱从哪来（常见来源）](#棋谱从哪来常见来源)
- [对话里怎么问](#对话里怎么问)
- [Web 页面上的复盘面板](#web-页面上的复盘面板)
- [工具一览](#工具一览)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [开发与发布](#开发与发布)
- [许可](#许可)

## 它能帮你做什么

| 你想知道的 | 你怎么说 | 你会得到 |
|---|---|---|
| 这盘棋我哪儿下坏了 | 「复盘这盘棋 `C:\棋谱\xxx.sgf`」 | 按严重程度排好的问题手：第几手、谁下的、下在哪、**大恶手 / 失误 / 不精确**、掉了多少胜率与多少目 |
| 某一手为什么不好 | 「第 42 手为什么不好？」 | 这手的意图 + 问题所在 + 更好的下法与后续变化，口语讲解 |
| 换个下法会怎样 | 「第 42 手改下 R16 会怎样？」 | 一条主变：双方接下来怎么走、结果好不好 |
| 我想在自己的软件里看讲解 | 「把讲解写回棋谱」 | 逐手讲解写进棋谱的注释（标准 `C[]` 属性），任何能显示注释的打谱软件打开都能看到 |
| 我想要一份文字留档 | 「生成复盘报告」 | 同目录同名 `.review.md`：棋局信息 + 问题手表 + 已写回的讲解 |
| 只想看前半盘 / 只想看某一段 | 「只看前 50 手」 | 只讲这一段，省时省 token |

讲解由 DSH 会话里的「围棋老师」人格完成：先复述你的意图、指出问题、再给具体改进建议；术语密度按双方段位自动调整（18K~10K 用生活化比喻，9K~1D 用常规术语，2D 以上可以直接聊全局构思）。胜率与目差只是佐证——先讲棋理，再引数字。

## 5 分钟上手

```powershell
# ① 装插件（在插件的上一级目录执行；把 ./dsh-go-sensei 换成你的实际路径）
cd C:\dsh\WeiQi
dsh plugin --profile web add ./dsh-go-sensei

# ② 重启 dsh web，浏览器打开 http://127.0.0.1:3080
```

③ 把一份棋谱放进当前会话的工作区（或者记住它的完整路径），在对话里说：

> 复盘这盘棋 [庄生梦1n4k]vs[鍾易成1]1788532348030034222.sgf

Sensei 会自己读谱、找问题手、逐手讲解。想听 AI 的胜率与候选点，再花十分钟[装一次 KataGo](#装一次-katago让讲解带上-ai-数字)；不装也能得到一个只讲棋理的版本。

## 接入 DSH：安装、验证、卸载

### 前置

| 项 | 要求 |
|---|---|
| DSH | 能正常启动 `dsh web` |
| Node.js | **≥ 22.19**（见 `package.json` 的 `engines`；本机实测 v24.19.0） |
| 运行环境 | Windows / macOS / Linux 均可；依赖只有 3 个纯 JS 包，`npm install` 即可，**无编译步骤** |

### 安装

```powershell
# 方式一：本地目录（自己 clone 或改源码时用；装完是 link，改完重启即生效）
dsh plugin --profile web add ./dsh-go-sensei
dsh plugin --profile web add D:\path\to\dsh-go-sensei      # 也可以用绝对路径

# 方式二：直接从 GitHub 装（仓库公开）
dsh plugin --profile web add github:Zhuang-A/dsh-go-sensei
```

`dsh plugin` 会把这个包装进 `web` 这个 profile，并自动把声明了 `dsh.bundle` 的依赖加入 profile 的图层列表——不需要你手工改 `bundles`。**装完重启 `dsh web` 才生效。**

### 验证装好了

```powershell
# 合成后的配置里应该能看到 go-sensei 这一层
dsh --profile web --dump-config | Select-String -Context 0,3 go-sensei
```

再看两处：

- Web 页面**输入框下方**出现一行「**DeepGo Sensei**」+「展开」按钮 → 浏览器端加载成功。
- 对话里随便问一句围棋，比如「帮我看看这盘棋」→ 模型开始用围棋老师的口吻回应，并能列出 `go_*` 系列工具 → 宿主端加载成功。

### 升级与卸载

```powershell
dsh plugin --profile web update dsh-go-sensei        # 升级（本地 link 安装无需此步）
dsh plugin --profile web remove dsh-go-sensei        # 卸载
```

卸载后重启 `dsh web` 并刷新页面：面板与样式都不会残留。

## 配置项

**全部可选，一个都不配也能用。** 配置写在 profile 的补丁层文件里：

```
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml      # Windows
~/.dsh/profiles/web/cordis.patch.yml                  # macOS / Linux
```

（若你设过 `DSH_HOME`，就是 `$DSH_HOME\profiles\web\cordis.patch.yml`。目前 Web 设置页里没有 Sensei 的配置卡片，改配置请直接编辑这个文件。）

```yaml
# ── DeepGo Sensei ─────────────────────────────────────────
# 路径用正斜杠，既被 Windows 接受，也避免 YAML 反斜杠转义踩坑。
- id: go-sensei
  config:
    level: auto                 # 讲解难度 18K..1K/1D..9D，或 auto（按双方段位自适应）
    winrateThreshold: 0.03      # 问题手胜率落差阈值（0~1 小数）
    scoreThreshold: 3           # 问题手目差阈值（目）
    maxCandidates: 10           # 每次复盘最多返回多少个问题手
    pvDepth: 6                  # 每条变化图保留多少手
    tokenBudget: 50000          # 单局讲解的 token 预算（软约束）
    kataGoPath: D:/katago/katago.exe                                # 留空＝不启用补算
    kataGoConfig: D:/katago/analysis_example.cfg                    # 可选
    kataGoModel: D:/katago/kata1-b18c384nbt-s9996604416-....bin.gz  # 可选
    maxVisits: 100              # 补算每手搜索量：越大越准越慢
```

没写的键一律用默认值。各项含义：

| 配置项 | 默认 | 作用 |
|---|---|---|
| `level` | `auto` | 讲解难度；`auto` 时按棋谱双方段位取**较弱**一方（照顾初学者） |
| `winrateThreshold` | `0.03` | 胜率落差超过该值即算问题手（3% 是 KataGo 的"失误线"） |
| `scoreThreshold` | `3` | 目差落差超过该值也算问题手（与胜率通道任一触发即标记） |
| `maxCandidates` | `10` | 单次复盘返回的问题手上限（按严重度排序取前 N） |
| `pvDepth` | `6` | 每条候选变化图截断到几手 |
| `tokenBudget` | `50000` | 单局讲解预算，写进人设段作为软约束 |
| `kataGoPath` | `''` | KataGo 可执行文件。**留空＝不注册 `go_engine_analyze`、也不会自动补算** |
| `kataGoConfig` | `''` | analysis 配置文件（可选） |
| `kataGoModel` | `''` | 模型权重（可选；填了就用 `-model` 传给引擎） |
| `maxVisits` | `100` | 补算每手搜索量 |

## 装一次 KataGo，让讲解带上 AI 数字

### 先判断你需要不需要它

| 你的棋谱 | 插件会怎么做 | 要装 KataGo 吗 |
|---|---|---|
| 自带 AI 分析数据（`WV[]`/`LZ[]` 属性，或注释里有胜率行） | 直接读棋谱里的分析来讲解 | ❌ 不用 |
| 没有任何分析数据 | 自动起 KataGo 补算问题手，再讲解 | ✅ 要 |
| 没有任何分析数据，也没配引擎 | 走「纯棋理」模式：只讲棋理，不虚构胜率与变化图 | ❌ 不用 |

怎么判断棋谱有没有分析数据：用记事本打开 `.sgf`，搜 `WV[` 或 `LZ[`，或者搜「胜率」。搜得到就是自带分析。

### 需要备齐三样（缺一不可）

1. **`katago.exe`** —— 版本 **v1.14 以上**（v1.14 起 analysis 模式默认 JSON 协议；本机实测 v1.16.4）。
2. **模型权重** —— 形如 `kata1-b18c384nbt-….bin.gz` 的文件。
3. **一份 analysis 配置文件** —— 必须是 analysis 配置，**不能**拿 GTP 配置顶替。

### 步骤 1：下载引擎

打开 [KataGo releases](https://github.com/lightvector/KataGo/releases)，挑一个文件名里带 `windows-x64` 的压缩包，按你的机器选后端：

| 你的机器 | 选哪个 | 说明 |
|---|---|---|
| 有独显、想最省事 | **opencl** 版 | NVIDIA / AMD / Intel 都能用，需要显卡驱动带 OpenCL |
| NVIDIA 显卡，愿意折腾驱动 | cuda 版 | 最快，但要装对应版本的 CUDA 运行库 |
| 没有独显 / 只有核显 / 不想碰驱动 | **eigen** 或 `eigenavx2` 版 | 纯 CPU，慢一些但一定能跑 |
| 服务器、专业显卡 | tensorrt 版 | 最快也最挑环境，新手不建议 |

解压到一个固定目录，例如 `D:\katago\`。

> ⚠️ **整个目录一起留着，别只拷 `katago.exe`。** 它依赖同目录的一堆 DLL（`libcrypto-3-x64.dll`、`libssl-3-x64.dll`、`libz.dll`、`libzip.dll`、`msvcp140*.dll`、`vcruntime140*.dll`），只拷 exe 会启动即失败。

### 步骤 2：下载模型权重

到 [katagotraining.org](https://katagotraining.org/) 下载最新的权重文件：

- **b18c384nbt**（约 98 MB）：够业余棋友复盘用，推荐先用这个。
- **b28c512nbt**（约 270 MB）：更强也更慢，机器好再上。

放进同一个目录，例如 `D:\katago\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`。

### 步骤 3：准备 analysis 配置文件

用引擎目录里自带的 **`analysis_example.cfg`**（官方压缩包里就有），**不需要改任何一行**：

- 搜索量由插件在查询里指定（`maxVisits`，见配置项），配置文件里的 `maxVisits` 不生效。
- 插件会额外加 `-override-config numAnalysisThreads=1`，避免多线程和单次查询抢资源。
- 配置里的 `reportAnalysisWinratesAs` 决定胜率视角（本机随包配置实测是 `BLACK`），插件会读这一个键做口径换算——所以别删它。

如果你的压缩包里没有这个文件，从官方仓库取：
<https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/configs/analysis_example.cfg>

> ⚠️ **别拿 GTP 配置顶替**（形如 `default_gtp.cfg`、`myconfig.cfg` 的那类）。GTP 配置缺 analysis 模式必需的键，引擎会直接报 `Could not find key`。

### 步骤 4：先自己验证一次引擎

```powershell
D:\katago\katago.exe version
```

正常输出（本机实测）：

```
KataGo v1.16.4
Git revision: 4b8de63bea2bd8790db96cd6f8daf86dc87be6f7
Compile Time: Oct 20 2025 12:25:23
Using OpenCL backend
```

能打印版本号与 `Using <后端> backend` 就算过了。这一步报错就先别往插件里填，先把引擎跑通。

### 步骤 5：把三个路径填进插件配置

回到 [配置项](#配置项)，在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 里写：

```yaml
- id: go-sensei
  config:
    kataGoPath: D:/katago/katago.exe
    kataGoConfig: D:/katago/analysis_example.cfg
    kataGoModel: D:/katago/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz
    maxVisits: 100
```

重启 `dsh web`。之后凡是**没有分析数据、19 路**的棋谱，`go_review_moves` 与 Web 面板都会**自动补算**，不需要你手动调工具；补算失败不会打断复盘，会降级成纯棋理模式并把失败原因如实带回。

### 常见装机坑

| 现象 | 原因与解法 |
|---|---|
| 引擎起不来 / 一闪而过 | 只拷了 exe 没拷 DLL；或后端和自己的显卡不匹配（用 `katago.exe version` 验证） |
| `Could not find key` | 配置文件用错了——需要 analysis 配置，不是 GTP 配置 |
| `Must be a integer or half-integer from -150.0 to 150.0`（`field` 却写着 `rules`） | 这是**贴目**超范围/非半整数，不是规则字符串的问题（KataGo v1.16.4 实测会把字段误标为 `rules`）。插件已把棋谱 `KM[]` 就近吸附到 0.5 的倍数并夹到 `[-150, 150]`；仍报则检查棋谱贴目 |
| 第一次补算等很久 | 每次补算都要新起一个引擎进程并加载模型（首次还有 OpenCL 调优），几十秒到一两分钟都属正常 |
| 补算太慢 | 把 `maxVisits` 调小（60~100 足够业余复盘用）；或换更小的模型 |
| 补算被拒 / 报子进程不可用 | 引擎查询被拒会把引擎原始错误带回；受限沙箱下启动子进程也可能被系统拒绝，工具会照实说明 |

补算耗时会在 `go_engine_analyze` 的返回里以 `seconds` 字段给出，跑几次就有直观感受。

## 棋谱要求（SGF 格式）

### 基本要求

| 项 | 要求 |
|---|---|
| 文件 | 磁盘上一个 `.sgf` 文件，路径可以是绝对路径，也可以相对当前会话工作区 |
| 内容 | 标准 SGF（`(;GM[1]FF[4]SZ[19]…`），**主变化线就是实战手顺** |
| 手顺 | 只复盘**主变化线**（每个节点第一个子节点）；谱中的变化图/旁支会被统计但不逐手讲解 |
| 多局 | 一个文件里有多局时，只复盘第一局 |
| 题目型 | 只有摆子（`AB`/`AW`）没有实战手顺的死活题/布局题，没有可复盘的手 |

主变化线之外的手数不影响使用：在打谱软件里摆过的变化图、做过的手顺标记都可以留着。

### 编码：不用管，插件自己认

- 优先按 **UTF-8** 严格解码；不是 UTF-8 就回退 **GBK**（野狐、部分国产导出器常见）。
- 棋手名/棋局名若是「UTF-8 被当 GBK 解」的双重乱码，插件会尝试**无损回修**；修不干净时保留原文并给出 warning（不影响棋局分析）。
- 写回注释后文件统一存为 **UTF-8**。

### 会被读取的属性

| 属性 | 含义 | 用途 |
|---|---|---|
| `SZ` | 棋盘路数 | 缺省按 19 路；**补算只支持 19 路** |
| `KM` | 贴目 | 传给引擎；旧式 `KM[375]` 这类百分制写法会先归一化成 3.75 |
| `HA` | 让子数 | 补算支持 **2~9 子**，更多子数会明确报错 |
| `RU` | 规则 | 含 `japan` 按日本规则，其余按中国规则传给引擎 |
| `PB`/`PW`/`BR`/`WR` | 棋手与段位 | 用于 `level: auto` 判断讲解深浅 |
| `RE`/`DT`/`GN`/`EV`/`AP` | 结果/日期/棋局名/赛事/软件 | 出现在复盘信息与报告里 |

### 分析数据：三种写法都认

棋谱里只要有**任意一手**带分析数据，插件就直接用，不再补算。识别三种常见写法：

1. **KataGo 标准属性**：`WV[]`（白方视角胜率）、`DM[]`（黑方视角目差）、`PV[]`（后续变化）。
2. **分析属性**：`LZ[]` / `LZOP[]`（部分打谱软件保存分析数据时写入的私有属性）。
3. **注释里的胜率行**：把分析写进 `C[]` 的软件，形如 `Move 42 黑胜率: 94.3% (±0.1%) (KataGo-18b / 1.0k 计算量)`。插件按通行口径解析这类文本。

### 无分析数据 + 已配 KataGo → 自动补算

触发条件（三条同时满足）：

- 配置里 `kataGoPath` 非空；
- 棋谱**完全没有**分析数据（有一手带分析就不触发）；
- 棋盘是 **19 路**。

补算失败不阻断复盘：自动降级为纯棋理模式，并把原因（引擎退出码、引擎拒绝查询的原文、子进程不可用等）带回。

## 棋谱从哪来（常见来源）

| 来源 | 怎么拿到 | 注意 |
|---|---|---|
| **野狐（腾讯围棋）** | 对局结束后在棋谱/历史对局里「保存棋谱 / 导出 SGF」，文件名形如 `[庄生梦1n4k]vs[鍾易成1]1788532348030034222.sgf` | 常见 **GBK 编码**（插件自动识别）；导出的是对局记录，**一般不含 AI 分析数据**，想让 Sensei 出胜率与候选点就配 KataGo 补算 |
| **弈城（Tygem）** | 复盘界面里保存 SGF | 编码可能是本地编码；棋手名万一乱码，插件会尝试自愈 |
| **OGS / KGS 等网络平台** | 对局页面「下载 SGF / Export」 | 一般是 UTF-8，直接能用 |
| **电脑上自己下的棋** | Sabaki、CGoban 等打谱软件保存的 SGF | 若软件支持"保存分析数据"，导出的棋谱会自带胜率与候选点 |
| **AI 自战 / 让子对局 / 教练给的谱** | 直接拿文件即可 | 让子棋补算支持 2~9 子 |
| **只有图片或纸质棋谱** | 先用打谱软件把棋摆一遍再导出 SGF | 插件只吃 `.sgf` 文件，不能从图片或剪贴板里读棋谱 |

**棋谱放哪、怎么写路径**

- 放进当前会话的工作区目录，对话里直接写文件名就行；也可以给绝对路径（如 `C:\棋谱\2026-09-12-对局.sgf`）。
- 野狐导出的文件名带中文与方括号 `[]`，Windows 下照抄即可；路径里有空格时用引号包起来，或在输入框里用 `@` 引用文件。
- 相对路径按**当前会话工作区**解析；Web 面板除了会话工作区，还会在你最近复盘过的目录里按文件名做一次有界查找。

## 对话里怎么问

```text
复盘这盘棋 C:\棋谱\2026-09-12-对局.sgf
只看前 50 手，后面官子先不用讲
第 42 手为什么不好？我是 5K，讲简单点
第 42 手改下 R16 会怎样？给一条主变就行
把讲解写回棋谱
生成复盘报告
```

- 想省 token：先说「只看第 1~60 手」，再逐段追问。
- 同一局反复问：命中同局面缓存（工具返回 `cached: true`），不会重复消耗。
- 讲解口吻、术语密度都可以直接提要求（「讲简单点」「讲深一点」），Sensei 会照办。

## Web 页面上的复盘面板

Web 页面**输入框下方**有一行折叠面板「**DeepGo Sensei**」：

1. 点「展开」，填入 SGF 路径（相对工作区或绝对路径）；
2. 点「读取问题手」，得到一张列表：第 N 手 / 黑白 / 坐标 / 标签徽标 / 胜率差 / 目差 / AI 首选；
3. **点任意一行**，追问语会自动写进输入框，回车即可让 Sensei 展开讲。

面板与对话走同一条管线（含自动补算），所以结果一致；它只读文件、不改动任何东西，路径也被限制在已知工作区目录之内。

## 工具一览

| 工具 | 作用 | 需要什么 |
|---|---|---|
| `go_parse_sgf` | 读棋谱：棋手/段位/贴目/让子/结果/规则 + 每手序列 | 无 |
| `go_review_moves` | 找问题手：分级标签 + 胜率/目差落差 + 每手最多 3 个 AI 候选点 | 无（无分析数据且配了引擎时自动补算） |
| `go_position_context` | 某一手前后各 N 手的局面 + 该手的 AI 候选与变化图 | 无 |
| `go_write_review` | 把讲解写回棋谱注释（默认追加、可覆盖） | 无 |
| `go_export_report` | 导出 Markdown 报告（骨架或你给的全文） | 无 |
| `go_engine_analyze` | 对指定手数区间补算 | **需 KataGo**；`kataGoPath` 留空时此工具不出现 |

## 常见问题

- **面板没出现**：确认 `dsh --profile web --dump-config` 里有 `go-sensei` 这一层，并**重启过 `dsh web`**；卸载插件后要刷新页面才会消失。
- **野狐棋谱棋手名乱码**：文件是 GBK 或双重乱码，插件会自动解码并尽量回修；个别字符已损坏时保留原文并给出 warning，不影响棋局分析。
- **棋谱没有分析数据**：插件走纯棋理模式；想让 Sensei 出胜率与候选点，按上文配一次 KataGo（有引擎时会自动补算）。
- **面板说找不到文件**：相对路径以**会话工作区**为基准；不确定就直接给绝对路径。
- **复盘很慢**：补算时间是「棋谱手数 × `maxVisits`」的函数，且每次都要加载模型；把 `maxVisits` 调小、或只补算关心的手数区间（`go_engine_analyze` 支持 `from`/`to`）。
- **写回之后文件排版变了**：写回会重新序列化整个棋谱——手数、旁支、属性与原有注释都保留（实测 106 手分析谱写回后手数、变化图数量不变），但**原文件的排版与逐字节格式不再保留**，输出统一 UTF-8。介意排版的话，写回前先备份棋谱。
- **token 花费**：单局默认预算 5 万 token（软约束）；插件做了数据裁剪（每手最多 3 个候选、变化图截断、数值保留 1 位小数）与同局面缓存。批量复盘建议安排在模型闲时。

## 已知限制

- **补算只支持 19 路**；让子棋支持 2~9 子，更多子数会明确报错。
- **补算规则按棋谱的 `RU[]` 判断**：含 `japan` 用日本规则，其余一律中国规则；贴目取自 `KM[]`，会吸附到 0.5 的整数倍并夹在 `[-150, 150]`。
- **胜率视角取决于引擎配置**：插件读 `kataGoConfig` 里的 `reportAnalysisWinratesAs` 做换算（读不到时按 KataGo 默认＝行棋方视角）。改了引擎配置，同一盘棋的胜率数字会变，属预期。
- **写回依赖沙箱策略服务**：DSH 沙箱后端下，写入会带上调用会话的策略；若该服务不可用，写回会被拒绝并给出 `file access denied` 警告。
- **报告骨架靠整行匹配**区分「引擎分析行」与「人写的讲解」；若某种导出器的分析行格式很特殊，可能被当成讲解收进报告——导出后扫一眼即可。
- **题目型棋谱**（只有摆子、没有实战手顺）没有可复盘的手数。

## 开发与发布

```powershell
npm install
npm test        # node:test 单测（含真实野狐导出棋谱夹具）
npm run check   # 语法检查（零构建，纯 JS）

# 无模型演示：对任意 SGF 跑 解析→复盘→写回（写 .demo.sgf 副本，不动原文件）
node scripts/demo.mjs <sgf路径> [起始手] [结束手]
```

`test/engine.test.mjs` 里的真机 KataGo 集成测试，只在环境变量 `KATAGO_PATH` 指向可用引擎时运行（受限沙箱下启动子进程会被拒，测试会自动跳过），无引擎环境同样跳过。

源码仓库：<https://github.com/Zhuang-A/dsh-go-sensei>（`main` 分支，语义化版本 tag）。发一版时同步改 `package.json` 的 `version` 并打同名 tag，`git push --follow-tags`。

### 改工具 schema 前必读

`ctx.tools.register` 会对每个工具的 `parameters` 与 `output.schema` 跑 DSH 的 `assertSupportedJsonSchema`；**不通过就抛错、插件加载中止，`dsh web` 直接起不来**。支持的关键字只有：

`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解类（`description` / `title` / `default` / `examples`）。

三条实测踩过的坑：`type` 必须是单一类型字符串（写 `type: ['object','null']` 会报 `UNSUPPORTED_SCHEMA`，可选字段请省略该键）；白名单外的关键字（`pattern` / `minimum` / `format` 等）一律被拒；`type` 与 `oneOf` 不能同时出现。

`test/schema.test.mjs` 直接 import 运行时校验器，对每个工具的两份 schema 逐条断言并显式禁止 `type` 数组——改完 schema 跑一次 `npm test` 就能拦住这类启动级故障。

### 仓库约定

- 换行策略见 `.gitattributes`：源码统一 LF（不依赖各机器的 `core.autocrlf`）；`test/fixtures/*.sgf` 标 `-text`，按**字节原样**提交——真实野狐导出的夹具本身是 CRLF，一旦被 EOL 规范化改写，逐字节依赖夹具的解析测试就会失真。
- 不入库：`node_modules/`、`test/tmp-workspace/`、`*.tgz`、`*.demo.sgf`、`*.log`。

## 许可

MIT。
