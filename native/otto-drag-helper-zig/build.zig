const std = @import("std");

// Builds the x86 Windows OLE drag-source helper.
//
// The helper exists because Melodyne 3.2.2 (x86) misbehaves when the drag
// source is a 64-bit process. Zig cross-compiles the x86 binary without a
// Visual Studio x86 toolchain, so CI only needs the Zig tarball.
//
//   zig build   -> zig-out/bin/otto-drag-helper.exe
//
// The x86 target is part of the compatibility contract, not a build knob, so
// it is not exposed as an option.
pub fn build(b: *std.Build) void {
    // The helper is spawned once per drag; startup cost and size matter more
    // than debuggability.
    const optimize: std.builtin.OptimizeMode = .ReleaseSmall;
    const strip = b.option(bool, "strip", "strip debug information") orelse true;

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .x86,
        .os_tag = .windows,
        .abi = .gnu,
    });

    const exe = b.addExecutable(.{
        .name = "otto-drag-helper",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            // No C runtime: the helper only calls Win32 exports and Zig std
            // code that does not need libc. This keeps the binary a single
            // self-contained file, matching the /MT static-runtime intent of
            // the C++ helper it replaces.
            .link_libc = false,
            .strip = strip,
            .single_threaded = true,
        }),
    });

    exe.root_module.linkSystemLibrary("ole32", .{});
    exe.root_module.linkSystemLibrary("shell32", .{});
    exe.root_module.linkSystemLibrary("user32", .{});
    exe.subsystem = .windows;

    b.installArtifact(exe);
}
