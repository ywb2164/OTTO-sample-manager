//! x86 OLE drag-source helper for OTTO Sample Manager.
//!
//! Why this exists:
//!   Melodyne 3.2.2 is a 32-bit host. When it receives a file drag from a
//!   64-bit OLE source it completes the drop and then opens its bug reporter.
//!   The verified minimum contract Melodyne accepts is an *x86* OLE drag source
//!   exposing exactly one FORMATETC (CF_HDROP, TYMED_HGLOBAL,
//!   DVASPECT_CONTENT, lindex -1) with DROPFILES.fWide set.
//!
//! This is a 1:1 port of native/otto-drag-helper/main.cpp to Zig. The C++
//! original stays in the tree as the reference implementation.
//!
//! The Win32 declarations below are hand written on purpose: Zig 0.17 removed
//! @cImport, and translating windows.h produces a multi-megabyte module for the
//! handful of symbols this helper needs.
//!
//! Build:  zig build
//! Exit codes (same as the C++ helper):
//!   0  drop accepted with DROPEFFECT_COPY
//!   1  failure (OLE init, window, or drop rejected)
//!   2  bad arguments
//!   3  cancelled by the user (Escape)

const std = @import("std");

// ---------------------------------------------------------------------------
// Minimal Win32 ABI surface
// ---------------------------------------------------------------------------

const HANDLE = *anyopaque;
const HWND = *anyopaque;
const HINSTANCE = *anyopaque;
const HGLOBAL = *anyopaque;
const HBRUSH = *anyopaque;
const HCURSOR = *anyopaque;
const HICON = *anyopaque;
const LPCWSTR = [*:0]const u16;
const APCWSTR = [*:0]const u16;

const DWORD = u32;
const UINT = u32;
const BOOL = i32;
const HRESULT = i32;
const ATOM = u16;
const WPARAM = usize;
const LPARAM = isize;
const LRESULT = isize;

const GUID = extern struct {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [8]u8,
};

const POINT = extern struct {
    x: i32,
    y: i32,
};

const FORMATETC = extern struct {
    cfFormat: u16,
    ptd: ?*anyopaque,
    dwAspect: u32,
    lindex: i32,
    tymed: u32,
};

const STGMEDIUM_Value = extern union {
    hBitmap: ?*anyopaque,
    hMetaFilePict: ?*anyopaque,
    hEnhMetaFile: ?*anyopaque,
    hGlobal: ?HGLOBAL,
    lpszFileName: ?[*:0]u16,
    pstm: ?*anyopaque,
    pstg: ?*anyopaque,
};

const STGMEDIUM = extern struct {
    tymed: u32,
    u: STGMEDIUM_Value,
    pUnkForRelease: ?*anyopaque,
};

const DROPFILES = extern struct {
    pFiles: u32,
    pt: POINT,
    fNC: BOOL,
    fWide: BOOL,
};

const WNDPROC = *const fn (HWND, UINT, WPARAM, LPARAM) callconv(.winapi) LRESULT;

const WNDCLASSW = extern struct {
    style: UINT,
    lpfnWndProc: ?WNDPROC,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: ?HINSTANCE,
    hIcon: ?HICON,
    hCursor: ?HCURSOR,
    hbrBackground: ?HBRUSH,
    lpszMenuName: ?LPCWSTR,
    lpszClassName: ?LPCWSTR,
};

extern "kernel32" fn GlobalAlloc(flags: UINT, bytes: usize) callconv(.winapi) ?HGLOBAL;
extern "kernel32" fn GlobalLock(memory: ?HGLOBAL) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn GlobalUnlock(memory: ?HGLOBAL) callconv(.winapi) BOOL;
extern "kernel32" fn GlobalFree(memory: ?HGLOBAL) callconv(.winapi) ?HGLOBAL;
extern "kernel32" fn GetModuleHandleW(name: ?LPCWSTR) callconv(.winapi) ?HINSTANCE;
extern "kernel32" fn LocalFree(memory: ?*anyopaque) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn GetLastError() callconv(.winapi) DWORD;
extern "kernel32" fn GetCurrentThreadId() callconv(.winapi) DWORD;
extern "kernel32" fn GetCommandLineW() callconv(.winapi) LPCWSTR;
extern "kernel32" fn CreateFileW(
    name: LPCWSTR,
    access: DWORD,
    share: DWORD,
    security: ?*anyopaque,
    creation: DWORD,
    flags: DWORD,
    template: ?HANDLE,
) callconv(.winapi) ?HANDLE;
extern "kernel32" fn WriteFile(
    file: HANDLE,
    buffer: ?*const anyopaque,
    bytes: DWORD,
    written: ?*DWORD,
    overlapped: ?*anyopaque,
) callconv(.winapi) BOOL;
extern "kernel32" fn CloseHandle(handle: HANDLE) callconv(.winapi) BOOL;

extern "user32" fn RegisterClassW(class: *const WNDCLASSW) callconv(.winapi) ATOM;
extern "user32" fn CreateWindowExW(
    ex_style: DWORD,
    class_name: LPCWSTR,
    window_name: LPCWSTR,
    style: DWORD,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    parent: ?HWND,
    menu: ?*anyopaque,
    instance: ?HINSTANCE,
    param: ?*anyopaque,
) callconv(.winapi) ?HWND;
extern "user32" fn DefWindowProcW(window: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) LRESULT;
extern "user32" fn DestroyWindow(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn GetCursorPos(point: *POINT) callconv(.winapi) BOOL;
extern "user32" fn GetForegroundWindow() callconv(.winapi) ?HWND;
extern "user32" fn GetWindowThreadProcessId(window: ?HWND, process_id: ?*DWORD) callconv(.winapi) DWORD;
extern "user32" fn AttachThreadInput(attach: DWORD, attach_to: DWORD, state: BOOL) callconv(.winapi) BOOL;
extern "user32" fn SetLayeredWindowAttributes(window: HWND, key: DWORD, alpha: u8, flags: DWORD) callconv(.winapi) BOOL;
extern "user32" fn ShowWindow(window: HWND, command: i32) callconv(.winapi) BOOL;
extern "user32" fn SetWindowPos(
    window: HWND,
    insert_after: ?HWND,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    flags: UINT,
) callconv(.winapi) BOOL;
extern "user32" fn SetForegroundWindow(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn SetActiveWindow(window: HWND) callconv(.winapi) ?HWND;
extern "user32" fn SetFocus(window: HWND) callconv(.winapi) ?HWND;
extern "user32" fn SetCapture(window: HWND) callconv(.winapi) ?HWND;
extern "user32" fn GetCapture() callconv(.winapi) ?HWND;
extern "user32" fn ReleaseCapture() callconv(.winapi) BOOL;

extern "ole32" fn OleInitialize(reserved: ?*anyopaque) callconv(.winapi) HRESULT;
extern "ole32" fn OleUninitialize() callconv(.winapi) void;
extern "ole32" fn DoDragDrop(
    data_object: ?*anyopaque,
    drop_source: ?*anyopaque,
    allowed_effects: DWORD,
    effect: *DWORD,
) callconv(.winapi) HRESULT;

extern "shell32" fn SHCreateStdEnumFmtEtc(
    count: UINT,
    formats: *const FORMATETC,
    out: *?*anyopaque,
) callconv(.winapi) HRESULT;
extern "shell32" fn CommandLineToArgvW(command_line: LPCWSTR, argument_count: *c_int) callconv(.winapi) ?[*][*:0]u16;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

fn hr(comptime value: u32) HRESULT {
    return @bitCast(value);
}

const S_OK = hr(0x00000000);
const E_NOTIMPL = hr(0x80004001);
const E_NOINTERFACE = hr(0x80004002);
const E_POINTER = hr(0x80004003);
const OLE_E_ADVISENOTSUPPORTED = hr(0x80040003);
const DV_E_FORMATETC = hr(0x80040064);
const DV_E_LINDEX = hr(0x80040068);
const DV_E_TYMED = hr(0x80040069);
const DV_E_DVASPECT = hr(0x8004006B);
const STG_E_MEDIUMFULL = hr(0x80030070);
const DRAGDROP_S_DROP = hr(0x00040100);
const DRAGDROP_S_CANCEL = hr(0x00040101);
const DRAGDROP_S_USEDEFAULTCURSORS = hr(0x00040102);

const CF_HDROP: u16 = 15;
const CF_UNICODETEXT: u16 = 13;

const TYMED_HGLOBAL: u32 = 1;
const DVASPECT_CONTENT: u32 = 1;
const DATADIR_GET: u32 = 1;

const DROPEFFECT_NONE: u32 = 0;
const DROPEFFECT_COPY: u32 = 1;

const GMEM_MOVEABLE: UINT = 0x0002;
const GMEM_ZEROINIT: UINT = 0x0040;

const WS_POPUP: DWORD = 0x80000000;
const WS_EX_TOOLWINDOW: DWORD = 0x00000080;
const WS_EX_LAYERED: DWORD = 0x00080000;
const SW_SHOW: i32 = 5;
const SWP_SHOWWINDOW: UINT = 0x0040;
const LWA_ALPHA: DWORD = 0x00000002;
const MK_LBUTTON: DWORD = 0x0001;
const ERROR_CLASS_ALREADY_EXISTS: DWORD = 1410;

const GENERIC_WRITE: DWORD = 0x40000000;
const CREATE_ALWAYS: DWORD = 2;
const FILE_ATTRIBUTE_NORMAL: DWORD = 0x00000080;

const HWND_TOPMOST: ?HWND = @ptrFromInt(std.math.maxInt(usize));

// Well-known interface identifiers, spelled out so the helper does not need
// uuid.lib at link time.
const IID_IUNKNOWN = GUID{
    .Data1 = 0x00000000,
    .Data2 = 0x0000,
    .Data3 = 0x0000,
    .Data4 = .{ 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 },
};
const IID_IDATAOBJECT = GUID{
    .Data1 = 0x0000010E,
    .Data2 = 0x0000,
    .Data3 = 0x0000,
    .Data4 = .{ 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 },
};
const IID_IDROPSOURCE = GUID{
    .Data1 = 0x00000121,
    .Data2 = 0x0000,
    .Data3 = 0x0000,
    .Data4 = .{ 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 },
};

const MAX_PATH_UNITS: usize = 32768;

/// The process performs exactly one drag, so the source path lives in a static
/// buffer instead of being owned by the COM object.
var g_path: [MAX_PATH_UNITS]u16 = undefined;
var g_path_len: usize = 0;

var g_attached_thread: DWORD = 0;

/// Compile-time UTF-16 literal from an ASCII string.
fn w(comptime ascii: []const u8) [ascii.len:0]u16 {
    var out: [ascii.len:0]u16 = undefined;
    for (ascii, 0..) |ch, i| out[i] = ch;
    out[ascii.len] = 0;
    return out;
}

const CLASS_NAME = w("OttoDragHelperSourceWindow");
const EMPTY_STRING = w("");
const SELFTEST_FLAG = w("--selftest");
const WINDOW_TEST_FLAG = w("--window-test");

// ---------------------------------------------------------------------------
// IDataObject: a single CF_HDROP format, nothing else.
// ---------------------------------------------------------------------------

const IDataObjectVtbl = extern struct {
    QueryInterface: *const fn (*anyopaque, *const GUID, ?*?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
    GetData: *const fn (*anyopaque, ?*FORMATETC, ?*STGMEDIUM) callconv(.winapi) HRESULT,
    GetDataHere: *const fn (*anyopaque, ?*FORMATETC, ?*STGMEDIUM) callconv(.winapi) HRESULT,
    QueryGetData: *const fn (*anyopaque, ?*FORMATETC) callconv(.winapi) HRESULT,
    GetCanonicalFormatEtc: *const fn (*anyopaque, ?*FORMATETC, ?*FORMATETC) callconv(.winapi) HRESULT,
    SetData: *const fn (*anyopaque, ?*FORMATETC, ?*STGMEDIUM, BOOL) callconv(.winapi) HRESULT,
    EnumFormatEtc: *const fn (*anyopaque, DWORD, ?*?*anyopaque) callconv(.winapi) HRESULT,
    DAdvise: *const fn (*anyopaque, ?*FORMATETC, DWORD, ?*anyopaque, ?*DWORD) callconv(.winapi) HRESULT,
    DUnadvise: *const fn (*anyopaque, DWORD) callconv(.winapi) HRESULT,
    EnumDAdvise: *const fn (*anyopaque, ?*?*anyopaque) callconv(.winapi) HRESULT,
};

const FileDataObject = extern struct {
    lpVtbl: *const IDataObjectVtbl,
    refs: i32,
};

var g_data_object = FileDataObject{ .lpVtbl = &data_object_vtbl, .refs = 1 };

fn asDataObject(self: *anyopaque) *FileDataObject {
    return @ptrCast(@alignCast(self));
}

fn isEqualIid(left: *const GUID, right: *const GUID) bool {
    return std.mem.eql(u8, std.mem.asBytes(left), std.mem.asBytes(right));
}

fn validateHdropRequest(request: *const FORMATETC) HRESULT {
    if (request.cfFormat != CF_HDROP) return DV_E_FORMATETC;
    if (request.dwAspect != DVASPECT_CONTENT) return DV_E_DVASPECT;
    if (request.lindex != -1) return DV_E_LINDEX;
    if ((request.tymed & TYMED_HGLOBAL) == 0) return DV_E_TYMED;
    return S_OK;
}

fn hdropFormat() FORMATETC {
    return .{
        .cfFormat = CF_HDROP,
        .ptd = null,
        .dwAspect = DVASPECT_CONTENT,
        .lindex = -1,
        .tymed = TYMED_HGLOBAL,
    };
}

/// Allocates a CF_HDROP payload: DROPFILES header followed by a wide,
/// double-NUL terminated path.
fn createHdrop() ?HGLOBAL {
    const unit = @sizeOf(u16);
    const total = @sizeOf(DROPFILES) + (g_path_len + 1) * unit + unit;

    const memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total) orelse return null;
    errdefer _ = GlobalFree(memory);

    const locked = GlobalLock(memory) orelse return null;
    defer _ = GlobalUnlock(memory);

    const base: [*]u8 = @ptrCast(locked);
    const drop: *DROPFILES = @ptrCast(@alignCast(base));
    drop.pFiles = @intCast(@sizeOf(DROPFILES));
    drop.pt = .{ .x = 0, .y = 0 };
    drop.fNC = 0;
    drop.fWide = 1;

    const destination: [*]u16 = @ptrCast(@alignCast(base + @sizeOf(DROPFILES)));
    if (g_path_len > 0) @memcpy(destination[0..g_path_len], g_path[0..g_path_len]);
    destination[g_path_len] = 0;
    destination[g_path_len + 1] = 0;

    return memory;
}

fn dataObjectQueryInterface(self: *anyopaque, iid: *const GUID, out: ?*?*anyopaque) callconv(.winapi) HRESULT {
    const result = out orelse return E_POINTER;
    result.* = null;
    if (isEqualIid(iid, &IID_IUNKNOWN) or isEqualIid(iid, &IID_IDATAOBJECT)) {
        _ = dataObjectAddRef(self);
        result.* = self;
        return S_OK;
    }
    return E_NOINTERFACE;
}

fn dataObjectAddRef(self: *anyopaque) callconv(.winapi) u32 {
    const object = asDataObject(self);
    object.refs += 1;
    return @intCast(object.refs);
}

fn dataObjectRelease(self: *anyopaque) callconv(.winapi) u32 {
    const object = asDataObject(self);
    object.refs -= 1;
    if (object.refs < 0) object.refs = 0;
    return @intCast(object.refs);
}

fn dataObjectGetData(self: *anyopaque, format: ?*FORMATETC, medium: ?*STGMEDIUM) callconv(.winapi) HRESULT {
    _ = self;
    const request = format orelse return E_POINTER;
    const target = medium orelse return E_POINTER;

    const validation = validateHdropRequest(request);
    if (validation != S_OK) return validation;

    const memory = createHdrop() orelse return STG_E_MEDIUMFULL;
    target.tymed = TYMED_HGLOBAL;
    target.u.hGlobal = memory;
    target.pUnkForRelease = null;
    return S_OK;
}

fn dataObjectGetDataHere(self: *anyopaque, format: ?*FORMATETC, medium: ?*STGMEDIUM) callconv(.winapi) HRESULT {
    _ = self;
    _ = format;
    _ = medium;
    return DV_E_FORMATETC;
}

fn dataObjectQueryGetData(self: *anyopaque, format: ?*FORMATETC) callconv(.winapi) HRESULT {
    _ = self;
    const request = format orelse return E_POINTER;
    return validateHdropRequest(request);
}

fn dataObjectGetCanonicalFormatEtc(self: *anyopaque, format: ?*FORMATETC, out: ?*FORMATETC) callconv(.winapi) HRESULT {
    _ = self;
    _ = format;
    const target = out orelse return E_POINTER;
    target.ptd = null;
    return E_NOTIMPL;
}

fn dataObjectSetData(self: *anyopaque, format: ?*FORMATETC, medium: ?*STGMEDIUM, release: BOOL) callconv(.winapi) HRESULT {
    _ = self;
    _ = format;
    _ = medium;
    _ = release;
    return E_NOTIMPL;
}

fn dataObjectEnumFormatEtc(self: *anyopaque, direction: DWORD, out: ?*?*anyopaque) callconv(.winapi) HRESULT {
    _ = self;
    const result = out orelse return E_POINTER;
    result.* = null;
    if (direction != DATADIR_GET) return E_NOTIMPL;

    const format = hdropFormat();
    return SHCreateStdEnumFmtEtc(1, &format, result);
}

fn dataObjectDAdvise(self: *anyopaque, format: ?*FORMATETC, flags: DWORD, sink: ?*anyopaque, connection: ?*DWORD) callconv(.winapi) HRESULT {
    _ = self;
    _ = format;
    _ = flags;
    _ = sink;
    _ = connection;
    return OLE_E_ADVISENOTSUPPORTED;
}

fn dataObjectDUnadvise(self: *anyopaque, connection: DWORD) callconv(.winapi) HRESULT {
    _ = self;
    _ = connection;
    return OLE_E_ADVISENOTSUPPORTED;
}

fn dataObjectEnumDAdvise(self: *anyopaque, out: ?*?*anyopaque) callconv(.winapi) HRESULT {
    _ = self;
    if (out) |result| result.* = null;
    return OLE_E_ADVISENOTSUPPORTED;
}

const data_object_vtbl = IDataObjectVtbl{
    .QueryInterface = &dataObjectQueryInterface,
    .AddRef = &dataObjectAddRef,
    .Release = &dataObjectRelease,
    .GetData = &dataObjectGetData,
    .GetDataHere = &dataObjectGetDataHere,
    .QueryGetData = &dataObjectQueryGetData,
    .GetCanonicalFormatEtc = &dataObjectGetCanonicalFormatEtc,
    .SetData = &dataObjectSetData,
    .EnumFormatEtc = &dataObjectEnumFormatEtc,
    .DAdvise = &dataObjectDAdvise,
    .DUnadvise = &dataObjectDUnadvise,
    .EnumDAdvise = &dataObjectEnumDAdvise,
};

// ---------------------------------------------------------------------------
// IDropSource: copy-only, cancel on Escape, drop on left-button release.
// ---------------------------------------------------------------------------

const IDropSourceVtbl = extern struct {
    QueryInterface: *const fn (*anyopaque, *const GUID, ?*?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
    QueryContinueDrag: *const fn (*anyopaque, BOOL, DWORD) callconv(.winapi) HRESULT,
    GiveFeedback: *const fn (*anyopaque, DWORD) callconv(.winapi) HRESULT,
};

const CopyDropSource = extern struct {
    lpVtbl: *const IDropSourceVtbl,
    refs: i32,
};

var g_drop_source = CopyDropSource{ .lpVtbl = &drop_source_vtbl, .refs = 1 };

fn asDropSource(self: *anyopaque) *CopyDropSource {
    return @ptrCast(@alignCast(self));
}

fn dropSourceQueryInterface(self: *anyopaque, iid: *const GUID, out: ?*?*anyopaque) callconv(.winapi) HRESULT {
    const result = out orelse return E_POINTER;
    result.* = null;
    if (isEqualIid(iid, &IID_IUNKNOWN) or isEqualIid(iid, &IID_IDROPSOURCE)) {
        _ = dropSourceAddRef(self);
        result.* = self;
        return S_OK;
    }
    return E_NOINTERFACE;
}

fn dropSourceAddRef(self: *anyopaque) callconv(.winapi) u32 {
    const object = asDropSource(self);
    object.refs += 1;
    return @intCast(object.refs);
}

fn dropSourceRelease(self: *anyopaque) callconv(.winapi) u32 {
    const object = asDropSource(self);
    object.refs -= 1;
    if (object.refs < 0) object.refs = 0;
    return @intCast(object.refs);
}

fn dropSourceQueryContinueDrag(self: *anyopaque, escape_pressed: BOOL, key_state: DWORD) callconv(.winapi) HRESULT {
    _ = self;
    if (escape_pressed != 0) return DRAGDROP_S_CANCEL;
    if ((key_state & MK_LBUTTON) == 0) return DRAGDROP_S_DROP;
    return S_OK;
}

fn dropSourceGiveFeedback(self: *anyopaque, effect: DWORD) callconv(.winapi) HRESULT {
    _ = self;
    _ = effect;
    return DRAGDROP_S_USEDEFAULTCURSORS;
}

const drop_source_vtbl = IDropSourceVtbl{
    .QueryInterface = &dropSourceQueryInterface,
    .AddRef = &dropSourceAddRef,
    .Release = &dropSourceRelease,
    .QueryContinueDrag = &dropSourceQueryContinueDrag,
    .GiveFeedback = &dropSourceGiveFeedback,
};

// ---------------------------------------------------------------------------
// Hidden 16x16 source window. Attaching to the foreground input thread moves
// mouse capture away from Chromium so this process receives the button release
// that terminates DoDragDrop.
// ---------------------------------------------------------------------------

fn sourceWindowProc(window: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) LRESULT {
    return DefWindowProcW(window, message, wparam, lparam);
}

fn detachInput() void {
    if (g_attached_thread != 0) {
        _ = AttachThreadInput(GetCurrentThreadId(), g_attached_thread, 0);
        g_attached_thread = 0;
    }
}

fn createSourceWindow(instance: ?HINSTANCE) ?HWND {
    var window_class = std.mem.zeroes(WNDCLASSW);
    window_class.lpfnWndProc = &sourceWindowProc;
    window_class.hInstance = instance;
    window_class.lpszClassName = &CLASS_NAME;
    if (RegisterClassW(&window_class) == 0) {
        if (GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return null;
    }

    var cursor = POINT{ .x = 0, .y = 0 };
    _ = GetCursorPos(&cursor);

    const window = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_LAYERED,
        &CLASS_NAME,
        &EMPTY_STRING,
        WS_POPUP,
        cursor.x - 8,
        cursor.y - 8,
        16,
        16,
        null,
        null,
        instance,
        null,
    ) orelse return null;

    const current_thread = GetCurrentThreadId();
    const foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), null);
    if (foreground_thread != 0 and foreground_thread != current_thread) {
        if (AttachThreadInput(current_thread, foreground_thread, 1) == 0) {
            _ = DestroyWindow(window);
            return null;
        }
        g_attached_thread = foreground_thread;
    }

    _ = SetLayeredWindowAttributes(window, 0, 1, LWA_ALPHA);
    _ = ShowWindow(window, SW_SHOW);
    _ = SetWindowPos(window, HWND_TOPMOST, cursor.x - 8, cursor.y - 8, 16, 16, SWP_SHOWWINDOW);
    _ = SetForegroundWindow(window);
    _ = SetActiveWindow(window);
    _ = SetFocus(window);
    _ = SetCapture(window);

    if (GetCapture() != window) {
        detachInput();
        _ = DestroyWindow(window);
        return null;
    }

    return window;
}

// ---------------------------------------------------------------------------
// Report helper (no allocator, no stdout: the helper is a GUI subsystem exe)
// ---------------------------------------------------------------------------

const Report = struct {
    buffer: *[4096]u8,
    len: usize = 0,

    fn add(self: *Report, comptime format: []const u8, args: anytype) void {
        const chunk = std.fmt.bufPrint(self.buffer[self.len..], format, args) catch return;
        self.len += chunk.len;
    }

    fn text(self: *const Report) []const u8 {
        return self.buffer[0..self.len];
    }
};

fn writeReport(path: LPCWSTR, body: []const u8) void {
    const handle = CreateFileW(
        path,
        GENERIC_WRITE,
        0,
        null,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        null,
    ) orelse return;
    if (@intFromPtr(handle) == std.math.maxInt(usize)) return;
    var written: DWORD = 0;
    _ = WriteFile(handle, body.ptr, @intCast(body.len), &written, null);
    _ = CloseHandle(handle);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

fn copyPathArgument(argument: LPCWSTR) bool {
    const slice = std.mem.span(argument);
    if (slice.len == 0 or slice.len >= MAX_PATH_UNITS) return false;
    @memcpy(g_path[0..slice.len], slice);
    g_path[slice.len] = 0;
    g_path_len = slice.len;
    return true;
}

fn runDrag(instance: ?HINSTANCE) u8 {
    if (OleInitialize(null) != S_OK) return 1;

    const window = createSourceWindow(instance) orelse {
        OleUninitialize();
        return 1;
    };

    var effect: DWORD = DROPEFFECT_NONE;
    const result = DoDragDrop(@ptrCast(&g_data_object), @ptrCast(&g_drop_source), DROPEFFECT_COPY, &effect);

    if (GetCapture() == window) _ = ReleaseCapture();
    detachInput();
    _ = DestroyWindow(window);
    OleUninitialize();

    if (result == DRAGDROP_S_CANCEL) return 3;
    if (result == DRAGDROP_S_DROP and (effect & DROPEFFECT_COPY) != 0) return 0;
    return 1;
}

/// `--selftest <sample> <report>` builds the data object, interrogates it the
/// way an OLE drop target would, and writes a pass/fail report. It never opens
/// a drag window, so it runs unattended.
fn runSelftest(sample: LPCWSTR, report_path: LPCWSTR) u8 {
    var storage: [4096]u8 = undefined;
    var report = Report{ .buffer = &storage };
    var failures: u32 = 0;

    if (!copyPathArgument(sample)) {
        report.add("copy_path=FAIL\n", .{});
        writeReport(report_path, report.text());
        return 1;
    }
    report.add("path_units={d}\n", .{g_path_len});

    var hdrop_request = hdropFormat();
    const query_result = dataObjectQueryGetData(&g_data_object, &hdrop_request);
    report.add("query_hdrop=0x{X:0>8}\n", .{@as(u32, @bitCast(query_result))});
    if (query_result != S_OK) failures += 1;

    var text_request = hdropFormat();
    text_request.cfFormat = CF_UNICODETEXT;
    const text_result = dataObjectQueryGetData(&g_data_object, &text_request);
    report.add("query_unicodetext=0x{X:0>8}\n", .{@as(u32, @bitCast(text_result))});
    if (text_result != DV_E_FORMATETC) failures += 1;

    var medium = std.mem.zeroes(STGMEDIUM);
    const data_result = dataObjectGetData(&g_data_object, &hdrop_request, &medium);
    report.add("get_data=0x{X:0>8}\n", .{@as(u32, @bitCast(data_result))});
    if (data_result != S_OK) {
        failures += 1;
    } else {
        const locked = GlobalLock(medium.u.hGlobal);
        if (locked == null) {
            report.add("lock=FAIL\n", .{});
            failures += 1;
        } else {
            const base: [*]u8 = @ptrCast(locked.?);
            const drop: *DROPFILES = @ptrCast(@alignCast(base));
            report.add("dropfiles_pfiles={d}\n", .{drop.pFiles});
            report.add("dropfiles_fwide={d}\n", .{drop.fWide});
            if (drop.pFiles != @sizeOf(DROPFILES)) failures += 1;
            if (drop.fWide != 1) failures += 1;

            const payload: [*:0]const u16 = @ptrCast(@alignCast(base + @sizeOf(DROPFILES)));
            const actual = std.mem.span(payload);
            report.add("payload_units={d}\n", .{actual.len});
            const matches = std.mem.eql(u16, actual, g_path[0..g_path_len]);
            report.add("payload_matches={s}\n", .{if (matches) "yes" else "no"});
            if (!matches) failures += 1;

            _ = GlobalUnlock(medium.u.hGlobal);
        }
        _ = GlobalFree(medium.u.hGlobal);
    }

    var enumerator: ?*anyopaque = null;
    const enum_result = dataObjectEnumFormatEtc(&g_data_object, DATADIR_GET, &enumerator);
    report.add("enum_formatetc=0x{X:0>8}\n", .{@as(u32, @bitCast(enum_result))});
    report.add("enum_has_object={s}\n", .{if (enumerator != null) "yes" else "no"});
    if (enum_result != S_OK or enumerator == null) failures += 1;

    report.add("failures={d}\n", .{failures});
    report.add("result={s}\n", .{if (failures == 0) "PASS" else "FAIL"});

    writeReport(report_path, report.text());
    return if (failures == 0) 0 else 1;
}

/// `--window-test <report>` registers the window class, creates the hidden
/// source window and destroys it again. It never shows the window, never calls
/// SetForegroundWindow/SetCapture, and never enters DoDragDrop, so it is safe
/// to run unattended. It exists to prove the WNDCLASSW layout and the window
/// procedure ABI, which are the parts a Zig port can silently get wrong.
fn runWindowTest(report_path: LPCWSTR) u8 {
    var storage: [4096]u8 = undefined;
    var report = Report{ .buffer = &storage };
    var failures: u32 = 0;

    const instance = GetModuleHandleW(null);

    var window_class = std.mem.zeroes(WNDCLASSW);
    window_class.lpfnWndProc = &sourceWindowProc;
    window_class.hInstance = instance;
    window_class.lpszClassName = &CLASS_NAME;
    const atom = RegisterClassW(&window_class);
    report.add("register_class={d}\n", .{atom});
    if (atom == 0 and GetLastError() != ERROR_CLASS_ALREADY_EXISTS) failures += 1;

    var cursor = POINT{ .x = 0, .y = 0 };
    _ = GetCursorPos(&cursor);

    const window = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_LAYERED,
        &CLASS_NAME,
        &EMPTY_STRING,
        WS_POPUP,
        cursor.x - 8,
        cursor.y - 8,
        16,
        16,
        null,
        null,
        instance,
        null,
    );
    report.add("create_window={s}\n", .{if (window != null) "yes" else "no"});
    if (window) |handle| {
        _ = DestroyWindow(handle);
        report.add("destroy_window=yes\n", .{});
    } else {
        failures += 1;
    }

    report.add("failures={d}\n", .{failures});
    report.add("result={s}\n", .{if (failures == 0) "PASS" else "FAIL"});

    writeReport(report_path, report.text());
    return if (failures == 0) 0 else 1;
}

pub fn main() u8 {
    var argument_count: c_int = 0;
    const arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count) orelse return 2;
    defer _ = LocalFree(@ptrCast(arguments));

    if (argument_count == 4 and std.mem.eql(u16, std.mem.span(arguments[1]), SELFTEST_FLAG[0..])) {
        return runSelftest(arguments[2], arguments[3]);
    }

    if (argument_count == 3 and std.mem.eql(u16, std.mem.span(arguments[1]), WINDOW_TEST_FLAG[0..])) {
        return runWindowTest(arguments[2]);
    }

    if (argument_count != 2 or arguments[1][0] == 0) return 2;
    if (!copyPathArgument(arguments[1])) return 2;

    return runDrag(GetModuleHandleW(null));
}
