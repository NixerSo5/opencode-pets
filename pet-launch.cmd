@echo off
rem pet-launch.cmd - Explorer context-menu entry point.
rem
rem Explorer passes the clicked folder via %V, which may contain spaces.
rem The whole argument list arrives through %*, so it is parsed here rather
rem than relying on %~1 (that would truncate a path such as "My Documents").

setlocal EnableDelayedExpansion
set "PET_DIR=%~dp0"
set "LOG=%TEMP%\openpets-launch.log"
echo [%DATE% %TIME%] start args=%* >> "%LOG%"

rem Everything after the script name. Expected: "<folder>" <x> <y>
set "ARGS=%*"

rem Drop the surrounding quotes of the first token, if present, then take the
rem remaining tokens as the coordinates. %%~a strips one level of quotes, which
rem avoids the `if "!VAR:~0,1!"==""` trap that breaks cmd's parser.
set "TARGET="
set "X=0"
set "Y=0"
for /f "tokens=1,*" %%a in ("!ARGS!") do (
  set "TARGET=%%~a"
  for /f "tokens=1,2" %%c in ("%%b") do (
    set "X=%%c"
    set "Y=%%d"
  )
)

if "!TARGET!"=="" set "TARGET=%USERPROFILE%\Desktop"
if "!X!"=="" set "X=0"
if "!Y!"=="" set "Y=0"
echo [%DATE% %TIME%] target=!TARGET! x=!X! y=!Y! >> "%LOG%"

rem Packaged build: the main exe sits one level above resources\, next to the
rem install directory. When present, launch it directly; no app path argument.
set "PACKAGED_EXE=%PET_DIR%..\OpenPets.exe"
if exist "%PACKAGED_EXE%" (
  echo [%DATE% %TIME%] launching packaged >> "%LOG%"
  pushd "%PET_DIR%.." || (
    echo OpenPets: cannot enter "%PET_DIR%..". >> "%LOG%"
    exit /b 1
  )
  start "" "%PACKAGED_EXE%" --summon --dir "!TARGET!" --x !X! --y !Y!
  echo [%DATE% %TIME%] packaged exit=%ERRORLEVEL% >> "%LOG%"
  popd
  endlocal & exit /b 0
)

rem Development build: run Electron with the project directory as the app.
if not exist "%PET_DIR%node_modules\electron\dist\electron.exe" (
  echo OpenPets: electron.exe not found under "%PET_DIR%node_modules\electron\dist". >> "%LOG%"
  exit /b 1
)

rem Use pushd so the child process inherits a valid working directory even when
rem Explorer starts us from a UNC path or a drive that no longer exists.
pushd "%PET_DIR%" || (
  echo OpenPets: cannot enter "%PET_DIR%". >> "%LOG%"
  exit /b 1
)

echo [%DATE% %TIME%] launching electron >> "%LOG%"
start "" /D "%PET_DIR%" "%PET_DIR%node_modules\electron\dist\electron.exe" "%PET_DIR%." --summon --dir "!TARGET!" --x !X! --y !Y!
echo [%DATE% %TIME%] start exit=%ERRORLEVEL% >> "%LOG%"

popd
endlocal