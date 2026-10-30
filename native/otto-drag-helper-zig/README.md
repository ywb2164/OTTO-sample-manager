# otto-drag-helper（Zig 版）

`native/otto-drag-helper/main.cpp` 的 1:1 移植，交叉编译为 **x86** Windows 可执行文件，
用于绕开 Melodyne 3.2.2（32 位宿主）对 64 位 OLE 拖拽源的兼容性缺陷。

协议与验证结论见 [tools/dnd-research/README.md](../../tools/dnd-research/README.md)：
Melodyne 能接受的最小契约是「x86 OLE 拖拽源 + 单一 `CF_HDROP` + `TYMED_HGLOBAL` +
`DVASPECT_CONTENT` + `lindex=-1` + `DROPFILES.fWide=TRUE`」。

## 为什么用 Zig

- 一条 `zig build` 就能产出 x86 PE，CI 不需要安装 Visual Studio 的 x86 工具链；
- 不链接 C 运行时（`link_libc = false`），产物约 68 KB 的单文件，无 msvcrt 依赖；
- 同一份源码换 `cpu_arch` 就能出 x64，便于将来给其他老旧宿主做兼容版本。

Win32 声明是手写的：Zig 0.17 移除了 `@cImport`，而用 translate-c 转换整份 `windows.h`
会得到一个几 MB 的模块，对只需十几个符号的 helper 不划算。手写声明集中在
`src/main.zig` 顶部，只包含实际用到的类型、常量和导出函数。

## 构建

需要 Zig 0.17 或更新版本（<https://ziglang.org/download/>）。

```powershell
# 推荐：构建 + 校验 + 自检 + 复制到打包位置
.\native\build-zig.ps1 -Zig C:\path\to\zig.exe

# 只构建
cd native\otto-drag-helper-zig
zig build
```

产物落在 `native/otto-drag-helper.exe`，正是 `electron-builder.yml` 里
`extraResources` 声明的路径，打包后位于 `resources/native/otto-drag-helper.exe`。
Electron 主进程的 `startMelodyneCompatibleDrag()` 无需任何改动。

构建脚本会做硬校验，不满足就拒绝复制：

- PE machine 必须是 `0x014C`（x86）；
- PE subsystem 必须是 `2`（GUI，不弹控制台）。

目标架构写死在 `build.zig` 里，**刻意不暴露 `-Dtarget`**：x86 是兼容性契约，不是构建选项。

## 自检

两个模式都不需要 Melodyne，也不进入真实拖拽，可无人值守运行：

```powershell
# 数据对象：模拟 OLE drop target 的调用序列
.\native\otto-drag-helper.exe --selftest C:\Windows\Media\Alarm01.wav report.txt

# 源窗口：注册窗口类 -> 创建 -> 销毁（不显示、不抢焦点、不 SetCapture）
.\native\otto-drag-helper.exe --window-test report.txt
```

`--selftest` 校验的内容：

- `QueryGetData(CF_HDROP)` 返回 `S_OK`；
- `QueryGetData(CF_UNICODETEXT)` 返回 `DV_E_FORMATETC`（证明没有多余格式）；
- `GetData(CF_HDROP)` 返回 `S_OK`，`STGMEDIUM.tymed == TYMED_HGLOBAL`；
- `DROPFILES.pFiles == 20`、`fWide == 1`；
- 载荷路径与入参**逐字相等**（覆盖中文/长路径）；
- `EnumFormatEtc(DATADIR_GET)` 返回 `S_OK` 且枚举器非空。

`--window-test` 校验 `WNDCLASSW` 的内存布局和窗口过程 ABI——这是 Zig 移植最容易
静默出错的地方（结构体字段顺序或 stdcall 约定错了，会在真实拖拽时才崩）。

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 成功（拖拽模式下表示 `DROPEFFECT_COPY` 被接受） |
| 1 | 失败（OLE 初始化、建窗、或拖拽被拒绝） |
| 2 | 参数错误 |
| 3 | 用户按 Esc 取消 |

与 C++ 版完全一致。

## 与 C++ 版的关系

- `native/otto-drag-helper/main.cpp` 保留为参考实现和行为基准，不删除；
- Zig 版逐函数对应：`IDataObject`（仅 `CF_HDROP`）、`IDropSource`（仅 copy）、
  隐藏的 16×16 源窗口、`AttachThreadInput` 抢占鼠标捕获；
- 两者输出同一个文件名、接受同样的单个路径参数，因此调用方与打包配置零改动。

## 尚未验证的部分

- **真机拖进 Melodyne 3.2.2 的人工验收**：本机没有安装 Melodyne，只有自检覆盖；
- 高完整性（UIPI）的 Melodyne 进程；
- 其他 Melodyne 3.x 点版本；
- FL Studio / VEGAS 的直接验证（默认路径仍是 Electron 的 `startDrag`，兼容模式默认关闭）。

参考 `tools/dnd-research/` 里原有的验证矩阵，人工验收时建议复用同一套用例：
短 ASCII、同一素材重复拖出（走副本）、中文路径、199 字符嵌套路径、兼容模式关闭。
