use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::{mem, ptr};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{E_INVALIDARG, GlobalFree, HWND};
use windows::Win32::System::Com::{
    DVASPECT_CONTENT, FORMATETC, IBindCtx, IDataObject, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalUnlock,
};
use windows::Win32::System::Ole::{
    CF_HDROP, DROPEFFECT_COPY, IDropSource, OleInitialize, OleUninitialize,
};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    CFSTR_PREFERREDDROPEFFECT, DROPFILES, ILFree, SHCreateDataObject, SHDoDragDrop,
    SHParseDisplayName,
};
use windows::core::{Error, PCWSTR};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDragOutcome {
    pub cancelled: bool,
    pub effect: u32,
}

pub fn create_file_data_object(paths: &[PathBuf]) -> windows::core::Result<IDataObject> {
    validate_drag_paths(paths)?;
    let mut pidls = Vec::<*mut ITEMIDLIST>::with_capacity(paths.len());
    for path in paths {
        let wide = wide_path(path);
        let mut pidl = std::ptr::null_mut();
        let parse_result = unsafe {
            SHParseDisplayName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>, &mut pidl, 0, None)
        };
        if let Err(error) = parse_result {
            free_pidls(&pidls);
            return Err(error);
        }
        pidls.push(pidl);
    }

    let absolute_pidls = pidls
        .iter()
        .map(|pidl| *pidl as *const ITEMIDLIST)
        .collect::<Vec<_>>();
    let result = unsafe {
        SHCreateDataObject::<_, IDataObject>(None, Some(&absolute_pidls), None::<&IDataObject>)
    };
    free_pidls(&pidls);
    let data_object = result?;
    set_hglobal_format(&data_object, CF_HDROP.0, &cf_hdrop_bytes(paths))?;

    let preferred_format = unsafe { RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) };
    if preferred_format == 0 {
        return Err(Error::from_win32());
    }
    set_hglobal_format(
        &data_object,
        preferred_format as u16,
        &DROPEFFECT_COPY.0.to_ne_bytes(),
    )?;
    Ok(data_object)
}

pub fn start_native_drag(
    hwnd: HWND,
    paths: &[PathBuf],
) -> windows::core::Result<NativeDragOutcome> {
    unsafe { OleInitialize(None)? };
    let result = (|| {
        let data_object = create_file_data_object(paths)?;
        let effect = unsafe {
            SHDoDragDrop(
                Some(hwnd),
                &data_object,
                None::<&IDropSource>,
                DROPEFFECT_COPY,
            )?
        };
        Ok(NativeDragOutcome {
            cancelled: effect.0 == 0,
            effect: effect.0,
        })
    })();
    unsafe { OleUninitialize() };
    result
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn validate_drag_paths(paths: &[PathBuf]) -> windows::core::Result<()> {
    if paths.is_empty() {
        return Err(Error::new(E_INVALIDARG, "drag requires at least one file"));
    }
    for path in paths {
        let metadata = path
            .metadata()
            .map_err(|error| Error::new(E_INVALIDARG, error.to_string()))?;
        if !metadata.is_file() || metadata.len() == 0 || !path.is_absolute() {
            return Err(Error::new(
                E_INVALIDARG,
                format!(
                    "drag path is not a non-empty absolute file: {}",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn cf_hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    let file_names = paths
        .iter()
        .flat_map(|path| path.as_os_str().encode_wide().chain(Some(0)))
        .chain(Some(0))
        .collect::<Vec<_>>();
    let header = DROPFILES {
        pFiles: mem::size_of::<DROPFILES>() as u32,
        pt: Default::default(),
        fNC: false.into(),
        fWide: true.into(),
    };
    let mut bytes = vec![0_u8; mem::size_of::<DROPFILES>() + file_names.len() * 2];
    unsafe {
        ptr::write_unaligned(bytes.as_mut_ptr().cast::<DROPFILES>(), header);
        ptr::copy_nonoverlapping(
            file_names.as_ptr().cast::<u8>(),
            bytes.as_mut_ptr().add(mem::size_of::<DROPFILES>()),
            file_names.len() * 2,
        );
    }
    bytes
}

fn set_hglobal_format(
    data_object: &IDataObject,
    clipboard_format: u16,
    bytes: &[u8],
) -> windows::core::Result<()> {
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())? };
    let destination = unsafe { GlobalLock(handle) };
    if destination.is_null() {
        unsafe {
            let _ = GlobalFree(Some(handle));
        }
        return Err(Error::from_win32());
    }
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(handle);
    }

    let format = FORMATETC {
        cfFormat: clipboard_format,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: Default::default(),
    };
    if let Err(error) = unsafe { data_object.SetData(&format, &medium, true) } {
        unsafe {
            let _ = GlobalFree(Some(handle));
        }
        return Err(error);
    }
    Ok(())
}

fn free_pidls(pidls: &[*mut ITEMIDLIST]) {
    for pidl in pidls {
        unsafe { ILFree(Some(*pidl)) };
    }
}
