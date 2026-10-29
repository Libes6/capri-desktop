; NSIS hooks of the Capri installer (Tauri bundler: bundle.windows.nsis.installerHooks), TAURI-13, docs/TAURI_BRIDGE.md.
;
; The Tauri installer is also what the Electron build's own updater (electron-updater, "bridge" release) runs:
;     <Capri-X-Windows-x64-setup.exe> --updated /S --force-run
; /S is NSIS's own silent switch; --updated and --force-run mean nothing to the Tauri template (it only reads /P /NS /UPDATE /R /ARGS
; /D=), so they are harmless. Two things differ from the Electron installer, and these hooks do them:
;
;   1. The Electron build is installed elsewhere ($LOCALAPPDATA\Programs\Capri, electron-builder one-click, per user, its own
;      uninstall key) than the Tauri one ($LOCALAPPDATA\Capri). Left alone it would stay as a second Capri with its own
;      shortcuts. PREINSTALL removes it the way electron-builder's own installer removes the previous version (old-uninstaller
;      copy, /S --updated, _?=<dir>); the user's data are kept (no --delete-app-data), and so is %APPDATA%\Capri for the
;      migration (src/main/migrate.js).
;   2. Electron's installer starts Capri again after a silent update when it is given --force-run; the Tauri one only on /R.
;      POSTINSTALL starts it for --force-run (and not twice when /R is given too).
;
; NOT RUN on Windows by the author (no Windows machine): makensis was not available either. Everything here is conditional on
; the Electron uninstall key being there, so a clean machine and a Tauri-over-Tauri update skip it.

; electron-builder: UUID v5 of the appId "capri.desktop" in its namespace (package.json build.appId): the key of
; Software\Microsoft\Windows\CurrentVersion\Uninstall\<it> and of Software\<it> (InstallLocation).
!define CAPRI_ELECTRON_GUID "9c5def90-78d9-5c70-9c3f-c0c732c63009"

!macro NSIS_HOOK_PREINSTALL
  Push $R6
  Push $R7
  Push $R8
  ClearErrors
  ReadRegStr $R7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${CAPRI_ELECTRON_GUID}" "UninstallString"
  ${If} $R7 != ""
    ReadRegStr $R8 HKCU "Software\${CAPRI_ELECTRON_GUID}" "InstallLocation"
    ${If} $R8 == ""
      StrCpy $R8 "$LOCALAPPDATA\Programs\Capri"
    ${EndIf}
    ${If} ${FileExists} "$R8\Uninstall Capri.exe"
      DetailPrint "Removing the previous (Electron) Capri in $R8"
      ; a copy outside the folder (the uninstaller deletes its folder), run in place with _?= so that ExecWait waits for it
      CopyFiles /SILENT "$R8\Uninstall Capri.exe" "$TEMP\capri-electron-uninstall.exe"
      ExecWait '"$TEMP\capri-electron-uninstall.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$R8' $R6
      DetailPrint "The previous Capri's uninstaller answered $R6"
      Delete "$TEMP\capri-electron-uninstall.exe"
      Delete "$R8\Uninstall Capri.exe"
      RMDir "$R8"
    ${Else}
      ; its folder is gone but its registry entries are not: only the stale entries are removed
      DetailPrint "The previous (Electron) Capri is not in $R8; removing its stale entries"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${CAPRI_ELECTRON_GUID}"
      DeleteRegKey HKCU "Software\${CAPRI_ELECTRON_GUID}"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R8
  Pop $R7
  Pop $R6
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R6
  Push $R7
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R6
  ${IfNot} ${Errors}
    ClearErrors
    ${GetOptions} $CMDLINE "/R" $R7
    ${If} ${Errors}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R7
  Pop $R6
!macroend
