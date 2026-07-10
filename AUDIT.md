# 后续代码与体验审计项

本文件记录 2.4.2 导入修复之外仍值得处理、但本轮没有扩大范围实施的事项。

- **批量导入性能**：当前仍逐个调用元数据 IPC。导入 471 个文件时会产生 471 次串行请求；后续可增加批量元数据接口并限制并发。
- **“内存优化模式”无实际行为**：设置项会持久化，但未发现它改变缓存容量、解码策略或释放时机。应实现明确语义，或从界面移除以免误导。
- **空占位模块**：`src/hooks/useSearch.ts`、`src/hooks/useSelection.ts`、`src/components/SampleList/SampleList.tsx`、`src/components/StatusBar/TransportControls.tsx` 当前为空，应在后续重构时删除或完成迁移。
- **超大模块维护风险**：`src/App.tsx` 与 `src/store/sampleStore.ts` 承担过多职责。后续应按导入编排、数据恢复、列表交互和持久化边界逐步拆分，并用现有测试保证行为不变。

这些事项不会影响 2.4.2 对重复归组、递归扫描、导入诊断、旧数据协调和主屏定位的修复。
