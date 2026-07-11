!macro customCheckAppRunning
  checkAppRunningAgain:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${IfNot} ${Silent}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK closeRunningApp
        Quit
      ${EndIf}

      closeRunningApp:
        DetailPrint "Closing running ${PRODUCT_NAME}..."
        nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T`
        Pop $R1
        Sleep 1500

        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
          Pop $R1
          Sleep 1000
          ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${EndIf}

        ${If} $R0 == 0
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY checkAppRunningAgain
          Quit
        ${EndIf}
    ${EndIf}
!macroend

!macro customInit
  SetShellVarContext current

  ReadRegStr $R8 HKCU "Software\${APP_GUID}" "InstallLocation"
  ${If} $R8 == ""
    ReadRegStr $R8 HKLM "Software\${APP_GUID}" "InstallLocation"
  ${EndIf}

  ${If} $R8 != ""
    IfFileExists "$R8\Copy\lyrics-assemblies\*.*" 0 copyMigrationDone

    CreateDirectory "$APPDATA\sample-manager\copy-migration"
    ClearErrors
    CopyFiles /SILENT "$R8\Copy\lyrics-assemblies" "$APPDATA\sample-manager\copy-migration"
    IfErrors copyMigrationFailed copyMigrationDone

    copyMigrationFailed:
      MessageBox MB_OK|MB_ICONSTOP "无法备份旧版活字印刷素材。安装尚未修改旧版本，请关闭正在使用素材的程序后重试。"
      Abort
  ${EndIf}

  copyMigrationDone:
!macroend
