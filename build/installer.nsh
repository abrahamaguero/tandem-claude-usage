; Tandem writes its own "start with Windows" entry while it runs; the uninstaller takes it
; away. An update also runs the old version's uninstaller, and then the entry has to stay.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.klugeinteractive.tandem"
  ${endIf}
!macroend
