; installer.nsh - register the Explorer context menu for the installed copy.
; The registry keys are per-user (HKCU) so no elevation is needed, and they
; point at the copy of pet-launch.cmd shipped in <install>\resources.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenPetsSummon" "" "用 OpenPets 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenPetsSummon" "Icon" "$INSTDIR\resources\assets\assets\app-icon.ico"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenPetsSummon\command" "" '"$INSTDIR\resources\pet-launch.cmd" "%V" 0 0'

  WriteRegStr HKCU "Software\Classes\DesktopBackground\Shell\OpenPetsSummon" "" "用 OpenPets 打开"
  WriteRegStr HKCU "Software\Classes\DesktopBackground\Shell\OpenPetsSummon" "Icon" "$INSTDIR\resources\assets\assets\app-icon.ico"
  WriteRegStr HKCU "Software\Classes\DesktopBackground\Shell\OpenPetsSummon\command" "" '"$INSTDIR\resources\pet-launch.cmd" "%V" 0 0'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenPetsSummon"
  DeleteRegKey HKCU "Software\Classes\DesktopBackground\Shell\OpenPetsSummon"
!macroend
