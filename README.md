# sample-manager

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## 最近功能更新

### 交互优化 (2026-04-01)
1. **选中样本交互改进**：
   - 不再自动弹出操作栏，改为右键点击触发
   - 右键点击样本时：选中该样本并显示操作栏
   - 右键点击文件夹时：选中该文件夹内所有样本并显示操作栏

2. **操作栏界面优化**：
   - 移除重复的"关闭"按钮
   - 将"清除选中"改为"返回"（功能不变：清除选中状态并隐藏操作栏）
   - 将"删除选中"改为"移除采样"（功能不变：删除选中样本）

### 功能增强
1. **窗口透明度无极调节**：
   - 透明度滑块现在支持连续平滑调节（`step="any"`）
   - 显示精度提高到2位小数（`{opacity.toFixed(2)}`）
   - 调节范围：0.2 - 1.0

2. **波形显示质量提升**：
   - 波形采样点从1200增加到2400个
   - 波形显示更加细腻、精度更高

### 相关文件修改
- `src/store/sampleStore.ts`：添加`showSelectionBar`状态管理
- `src/App.tsx`：修改SelectionBar显示条件
- `src/components/SampleList/SampleItem.tsx`：右键菜单处理优化
- `src/components/FolderItem.tsx`：添加文件夹右键支持
- `src/components/SelectionBar.tsx`：界面文字优化
- `src/components/TitleBar.tsx`：透明度调节优化
- `src/hooks/useAudioEngine.ts`：增加波形采样点密度

### 使用说明
- **多选操作**：右键点击样本或文件夹触发选中操作栏
- **透明度调节**：点击设置按钮(⚙) → 调整"窗口透明度"滑块
- **清除选中**：点击操作栏中的"返回"按钮或按`Esc`键

---

**详细更新记录请查看** [CHANGELOG.md](CHANGELOG.md)
