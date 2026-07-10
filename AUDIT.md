# 后续代码与体验审计项

本文件记录 2.5.0 已完成的最小优化之外仍值得处理、但本轮没有扩大范围实施的事项。

- **大文件试听**：仍使用严格懒解码的 Web Audio 模式。若超过 32 MiB 或 5 分钟的素材成为常见场景，应单独设计 HTMLMediaElement 流式播放与低分辨率预计算波形。
- **导入并发上限**：批量 metadata IPC 已合并，但目录扫描和后续可能的音频预处理仍应在真实大库场景中评估 worker 化收益。
- **空占位模块**：`src/hooks/useSearch.ts`、`src/hooks/useSelection.ts`、`src/components/SampleList/SampleList.tsx`、`src/components/StatusBar/TransportControls.tsx` 当前为空，应在后续重构时删除或完成迁移。
- **超大模块维护风险**：`src/App.tsx` 与 `src/store/sampleStore.ts` 承担过多职责。后续应按导入编排、数据恢复、列表交互和持久化边界逐步拆分，并用现有测试保证行为不变。

这些事项不会影响 2.5.0 的撤回、应用内更新、批量元数据、增量搜索索引和音频缓存预算行为。
