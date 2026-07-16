# Tauri Windows 迁移验收手册

本文件记录不能由单元测试替代的发布硬门槛。未完成的项目不得作为“已通过”报告，也不得据此下线 Electron 稳定版。

## 自动化基准

在同一台 Windows 10/11 x64 机器、同一电源模式下，分别记录 Electron 稳定版和当前 Tauri 分支：

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example library_benchmark
```

该命令生成 1,000、10,000、50,000 条 SQLite 合成库，输出导入耗时、暖启动首屏查询 p95 和紧凑搜索索引流式读取耗时。搜索 Worker 的输入到稳定结果耗时应在 DevTools Performance 中另行记录，避免把测试进程启动成本混入结果。

| 指标 | Electron 基线 | Tauri 结果 | 门槛 | 状态 |
|---|---:|---:|---:|---|
| 50k 暖启动可交互 | 待测 | 待测 | ≤ 2 s | 未实测 |
| 10k 搜索 p95 | 待测 | 待测 | ≤ 80 ms | 未实测 |
| 50k 搜索 p95 | 待测 | 待测 | ≤ 150 ms | 未实测 |
| 短素材冷启动发声 p95 | 待测 | 待测 | ≤ 300 ms | 未实测 |
| 短素材缓存命中 | 待测 | 待测 | ≤ 80 ms | 未实测 |
| 长素材流式发声 | 待测 | 待测 | ≤ 600 ms | 未实测 |
| 取消导入停止发现文件 | 待测 | 待测 | ≤ 500 ms | 未实测 |
| setup 大小 | 约 81 MiB | 5.86 MiB | ≤ 30 MiB | 已通过（2026-07-16 本机 unsigned-check NSIS） |
| 空闲 private working set | 146.02 MiB（空库） | 179.20 MiB（空库，含 WebView2） | ≤ Electron 70% | 未通过空库预检 |

2026-07-16 在当前 Windows x64 开发机执行上述 Rust release 基准，数据层结果如下。该结果只证明
SQLite 写入、首屏分页和紧凑索引传输，不等同于 React 首屏可交互或 Worker 搜索 p95：

| 合成样本数 | SQLite 插入 | 暖首屏查询 p95 | 紧凑索引完整流式读取 |
|---:|---:|---:|---:|
| 1,000 | 19.16 ms | 0.31 ms | 0.80 ms |
| 10,000 | 217.86 ms | 5.33 ms | 41.38 ms |
| 50,000 | 1,107.67 ms | 23.25 ms | 1,274.95 ms |

结论：数据层首屏查询已有明显余量；renderer 当前虽会先显示前 500 条，但随后仍恢复完整 Sample
对象图，因此“50k React 可交互”和固定上限页缓存仍需单独验收，不能用本表替代。

同日执行 `npm run tauri:build -- --ci` 成功生成：

- `otto-sample-manager.exe`：17,790,976 bytes（16.97 MiB）；
- `采样管理器_2.5.0_x64-setup.exe`：6,143,488 bytes（5.86 MiB）。

该包未开启更新签名产物，仅用于 CI/本地体积与安装检查；正式 tag 发布仍必须使用 release overlay 和
生产 updater 私钥。

同机隔离空库启动 8 秒后，按 Windows
`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate` 汇总全部新增相关进程：Electron
4 个进程共 146.02 MiB；Tauri 主进程加 WebView2 共 7 个进程、179.20 MiB，约为 Electron 的
122.72%，没有达到“不超过 70%”门槛。普通 Working Set/Private Bytes 因共享页和未驻留提交量含义不同，
不用于该门槛。此结果要求 Electron 稳定版继续保留；还需在目标 Windows 10/11 与真实 50k 同库复测，
并调查当前 WebView2 Runtime 的进程开销。

连续试听 100 个大文件后停止播放，10 秒内记录 private working set；应稳定在空闲基线以上 128 MiB 以内。测试默认缓存预算为 PCM 64 MiB、波形 8 MiB；内存优化模式为 16 MiB / 4 MiB。

## Melodyne / FL Studio 原生拖出矩阵

每一项都必须在 Melodyne 与 FL Studio 各执行一次。观察 DAW 收到的文件数量和顺序，同时核对 `Copy/drag-copies` 及 SQLite `drag_counts`。取消拖拽不得增加计数，并应清除本轮新建但未使用的副本。

| 场景 | Melodyne | FL Studio |
|---|---|---|
| 单文件，第一次使用原件 | 未实测 | 未实测 |
| 单文件，第二次使用副本 | 未实测 | 未实测 |
| 多选一次拖出全部文件 | 未实测 | 未实测 |
| 中文与空格路径 | 未实测 | 未实测 |
| 长路径与 UNC 路径 | 未实测 | 未实测 |
| 跨盘路径 | 未实测 | 未实测 |
| 关闭自动副本 | 未实测 | 未实测 |
| 保留副本 | 未实测 | 未实测 |
| 用户取消拖拽 | 未实测 | 未实测 |
| 选中项含缺失文件 | 未实测 | 未实测 |

## 数据与更新链路

- 数据迁移：空库、旧字段缺失、重复路径、损坏 JSON、中断后重试、中文、Unicode、UNC、长路径。
- 逐项核对：samples、groups、folders、排序、文件夹设置、撤回状态、窗口设置、副本设置、拖出次数。
- 更新：Electron → 桥接版 → Tauri、Tauri → 下一版本、签名错误、SHA-256 错误、断网、下载中断、安装失败。
- 迁移失败时必须确认旧 JSON、`Copy/drag-copies`、`Copy/lyrics-assemblies` 和旧 Electron 安装均未被删除。

自动化测试已覆盖损坏 SQLite 启动：后端改用已迁移的内存数据库提供空的只读界面，并逐字节核对磁盘上的
损坏数据库没有被覆盖。旧 JSON 迁移失败同样会关闭增量保存、导入、原生拖出和活字印刷；关闭窗口时不清理
`Copy` 或写窗口设置。发布验收仍需用真实旧用户目录验证错误摘要可复制且下一次启动可以重试。

签名 release 使用 `src-tauri/tauri.release.conf.json`。CI 需要 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；公钥必须与 `tauri.conf.json` 中的 updater 公钥一致。仓库内 `src-tauri/keys/*.key` 永远不得提交。
