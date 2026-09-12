# 自带引擎（KataGo 18b）

这个目录随插件分发，让**装完就能补算**：不配任何路径时，插件就用这里的引擎与权重。

| 文件 | 说明 |
|---|---|
| `katago.exe` | KataGo v1.16.4，**OpenCL** 后端（Windows x64） |
| `*.dll` | 引擎运行必需的运行库（`libcrypto-3-x64` / `libssl-3-x64` / `libz` / `libzip` / `msvcp140*` / `vcruntime140*`）。**不要单独拷走 katago.exe** |
| `analysis_example.cfg` | analysis 模式配置（官方随包版本，未改动）。`reportAnalysisWinratesAs = BLACK` 决定胜率视角，插件读这一个键做换算 |
| `kata1-b18c384nbt-s9996604416-d4316597426.bin.gz` | 18b 权重（约 93 MB）。插件在引擎目录里自动挑**最大**的 `*.bin.gz` |
| `analysis_logs/` | 引擎日志目录（内容不入库，见仓库根 `.gitignore`） |
| `LICENSE.txt` | KataGo 的 MIT 许可与第三方组件声明 |

## 来源与许可

- 引擎与权重来自 KataGo 官方发布（<https://github.com/lightvector/KataGo/releases>、<https://katagotraining.org/>），
  按 MIT 许可随插件打包，仅为本机复盘省去一次手动安装。上游条款以官方发布为准。
- 自带的是 Windows x64 OpenCL 版：**非 Windows 平台不会自动启用**，请自行下载对应平台的引擎，
  把 `engineDir`（或 `kataGoPath`）指向它即可，其余逻辑完全一致。

## 换引擎 / 换权重

1. **换权重**：把任意 `*.bin.gz` 放进本目录，插件自动挑其中最大的一个（b28 比 b18 大，也更强）。
2. **指定权重**：配置 `kataGoModel` 填 `.bin.gz` 的完整路径。
3. **换引擎/后端**（CUDA、CPU 版等）：配置 `engineDir` 指向你自己的引擎目录（内含可执行文件、analysis 配置、权重）。
4. **只临时换一次**：`go_engine_analyze` 支持 `engineDir` / `kataGoPath` / `kataGoConfig` / `kataGoModel` 参数覆盖。
5. **看当前用的是哪个**：让 Sensei 调 `go_engine_info`。

细节见仓库根 `README.md` 的「装一次 KataGo」与「配置项」两节。
