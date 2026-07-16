# OTTO Drag, GUI Entry, and Bounded LRU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce valid Windows file drag objects, remove the release console window, and cap Tauri renderer sample details with a page LRU.

**Architecture:** Rust owns standards-compliant `CF_HDROP` memory and SQLite detail queries. The renderer owns only ordered row IDs plus an LRU of 256-record pages; the existing Electron store remains unchanged.

**Tech Stack:** Rust 2024, windows crate, Tauri 2, SQLite/rusqlite, React, Zustand, Web Worker, Vitest.

---

### Task 1: Prove and fix CF_HDROP contents

**Files:**
- Modify: `src-tauri/tests/native_drag.rs`
- Modify: `src-tauri/src/native_drag.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] Replace the `QueryGetData`-only assertion with `GetData` plus `DragQueryFileW` assertions for two non-empty Unicode paths.
- [ ] Run `cargo test --test native_drag` and confirm the current implementation does not satisfy the content assertion.
- [ ] Add a helper that allocates `DROPFILES + UTF-16 paths + final NUL` in `HGLOBAL` and publishes it through `IDataObject::SetData` with ownership transfer.
- [ ] Publish `Preferred DropEffect` as `DROPEFFECT_COPY`.
- [ ] Reject empty input, directories, zero-length files, and missing paths before creating the data object.
- [ ] Run the focused native drag and copy policy tests.

### Task 2: Use the Windows GUI subsystem for release

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] Add `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` before `main`.
- [ ] Build release and inspect the PE subsystem with a Windows binary inspection command; expect `WINDOWS_GUI`, not `WINDOWS_CUI`.

### Task 3: Add SQLite identity/detail query contracts

**Files:**
- Modify: `src-tauri/src/library_db.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/library_db.rs`
- Modify: `src/services/desktopBridge.ts`

- [ ] Write a database test for stable ordered identity pages and order-preserving batch detail lookup.
- [ ] Add serializable compact identity and detail-page DTOs.
- [ ] Add `library_query_sample_ids` and `library_get_samples_by_ids` commands without exposing SQL.
- [ ] Add typed bridge methods and verify TypeScript rejects mismatched DTOs.

### Task 4: Implement the bounded page cache

**Files:**
- Create: `src/services/libraryPageCache.ts`
- Create: `src/services/libraryPageCache.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/store/sampleStore.ts`
- Modify: `src/hooks/useSearch.ts`

- [ ] Write failing Vitest cases for LRU recency, 8-page default cap, 3-page low-memory cap, pinning, stale generation rejection, and deterministic page keys.
- [ ] Implement a framework-independent 256-record `LibraryPageCache`.
- [ ] Change Tauri hydration to load compact ordered IDs and only the first detail page.
- [ ] Drive visible-range prefetch from the virtualizer and load current/adjacent pages.
- [ ] Render unloaded rows as stable placeholders until their detail page arrives.
- [ ] Keep selection/search/range logic ID-based and pin playing/active/selected pages.
- [ ] Preserve the existing Electron hydration and full Map behavior.

### Task 5: Full verification and one final commit

**Files:**
- Modify: `docs/tauri-migration-acceptance.md`

- [ ] Run `npm run check:types` and `npm test`.
- [ ] Run `cargo fmt --all -- --check`, `cargo test --all-targets`, and `cargo clippy --all-targets -- -D warnings` under the Visual Studio developer environment.
- [ ] Run `npm run build` and `npm run tauri:build -- --ci`.
- [ ] Verify `CF_HDROP` paths can be read and refer to non-empty files; no DAW-specific interaction is required.
- [ ] Inspect `git diff --check`, ignored release artifacts, and private updater key handling.
- [ ] Stage the intentional migration changes and create one descriptive commit on `codex/tauri-windows-migration`.
