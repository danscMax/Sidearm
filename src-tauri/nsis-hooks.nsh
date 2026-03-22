; ============================================================================
; Sidearm NSIS Installer Hooks
; ============================================================================
; Installs the self-signed root CA certificate so that uiAccess="true"
; is honoured by Windows. Without a trusted cert, the OS silently ignores
; the uiAccess flag and SendInput remains blocked for elevated windows.
;
; The .cer file must be bundled as a Tauri resource (resources/sidearm-ca.cer).
; ============================================================================

!macro NSIS_HOOK_POSTINSTALL
  ; Install root CA certificate to LocalMachine\Root (Trusted Root CAs).
  ; certutil requires the elevation we already have from perMachine install.
  ; Skip if .cer is missing or is an empty placeholder (unsigned dev build).
  IfFileExists "$INSTDIR\resources\sidearm-ca.cer" 0 cert_skip
    FileOpen $1 "$INSTDIR\resources\sidearm-ca.cer" r
    FileSeek $1 0 END $2
    FileClose $1
    IntCmp $2 0 cert_skip cert_skip 0
      nsExec::ExecToLog 'certutil -addstore -f "Root" "$INSTDIR\resources\sidearm-ca.cer"'
      Pop $0
  cert_skip:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove the root CA certificate on uninstall.
  ; We use the certificate subject to find and delete it.
  nsExec::ExecToLog 'certutil -delstore "Root" "Sidearm Open Source"'
  Pop $0
!macroend
