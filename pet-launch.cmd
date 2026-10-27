@echo off
rem pet-launch.cmd - Explorer context-menu entry point.
rem Explorer passes the clicked folder as the first positional arg (%V or %1).
setlocal

set "PET_DIR=%~dp0"
set "LOG=%TEMP%\openpets-launch.log"
echo [%DATE% %TIME%] start args=%* >> "%LOG%"

rem First positional arg is the clicked folder. %~1 strips quotes, keeps spaces.
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%USERPROFILE%\Desktop"
echo [%DATE% %TIME%] target=%TARGET% >> "%LOG%"

rem Packaged build: main exe sits one level above this script's folder.
set "PACKAGED_EXE=%PET_DIR%..\OpenPets.exe"
if exist "%PACKAGED_EXE%" (
  echo [%DATE% %TIME%] launching packaged >> "%LOG%"
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%PACKAGED_EXE%' -ArgumentList '--summon','--dir','%TARGET%','--x','0','--y','0' -WorkingDirectory '%PET_DIR%..'"
  endlocal & exit /b 0
)

rem Development build: run Electron with the project directory as the app.
if not exist "%PET_DIR%node_modules\electron\dist\electron.exe" (
  echo OpenPets: electron.exe not found under "%PET_DIR%node_modules\electron\dist". >> "%LOG%"
  endlocal & exit /b 1
)

rem start re-parses quoted args and can drop --dir; use PowerShell Start-Process
rem so the target folder always reaches Electron intact.
echo [%DATE% %TIME%] launching electron >> "%LOG%"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%PET_DIR%node_modules\electron\dist\electron.exe' -ArgumentList '%PET_DIR%.','--summon','--dir','%TARGET%','--x','0','--y','0' -WorkingDirectory '%PET_DIR%'"
echo [%DATE% %TIME%] start exit=%ERRORLEVEL% >> "%LOG%"
endlocal
