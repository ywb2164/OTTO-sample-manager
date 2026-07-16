# OTTO 拖出、Windows GUI 入口与有界页面缓存设计

## 目标

1. Windows 拖出对象必须让任意标准 `CF_HDROP` 消费端读取到全部真实、存在且非空的文件；本轮不要求操作特定 DAW。
2. Tauri release/NSIS 启动时只显示应用窗口，debug 构建仍保留控制台。
3. Tauri renderer 不再在首屏之后恢复全库 `Sample` 对象，而以固定上限页面 LRU 保存详情。

## Windows 拖出

现实现把绝对 PIDL 作为 `SHCreateDataObject` 的子 PIDL 传入，且测试仅调用 `QueryGetData`。该测试无法证明 `CF_HDROP` 中存在可读取的路径。新实现直接分配可移动 `HGLOBAL`，写入 `DROPFILES` 与双零结尾的 UTF-16 绝对路径列表，再通过 `IDataObject::SetData` 发布 `CF_HDROP`。同时发布 `Preferred DropEffect = COPY`。

回归测试必须调用 `IDataObject::GetData` 和 `DragQueryFileW`，核对数量、顺序、Unicode/空格路径、文件存在性和非零长度。只有消费端能读回真实路径才算成功。

## Windows GUI 入口

`src-tauri/src/main.rs` 在非 debug 构建使用 `windows_subsystem = "windows"`。不引入启动脚本或隐藏终端进程。

## 有界页面 LRU

Tauri 模式将列表身份与完整详情分离：Worker/紧凑索引负责有序 ID、搜索、分组与目录归属；SQLite 负责按 ID 或分页读取完整记录。React 只缓存当前窗口附近的详情页。

- 页面大小：256 条。
- 默认上限：8 页，最多 2048 个完整 `Sample`。
- 低内存模式：3 页，最多 768 个完整 `Sample`。
- 当前播放、活动和已选 ID 对应的页为 pinned；状态解除后可淘汰。
- 每次可见范围变化时预取当前页及相邻页；命中已淘汰页时从 SQLite 重读。
- 搜索结果和范围选择持有 ID，不要求全库详情常驻。
- Electron 继续使用完整 Map，保持旧 JSON 行为。

文件夹和分组保留紧凑成员 ID，以维持计数、折叠和范围选择；文件路径、音频元数据等重字段只存在于详情 LRU。

## 错误处理与验收

读取页失败时保留现有缓存并显示持久化错误，不用空页覆盖。过期异步页响应按 generation 丢弃。拖出前再次验证每个路径为非零普通文件，无效项给出明确错误，不启动空拖放。

完成条件包括 Rust/TypeScript/Vitest/Clippy、Electron build、Tauri release/NSIS build，以及 `CF_HDROP` 真实内容回读测试全部通过。
