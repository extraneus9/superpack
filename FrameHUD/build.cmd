@echo off
rem Builds FrameHUD.exe with the C# compiler that ships with Windows (.NET Framework 4.8),
rem then packages dist\FrameHUD-Setup.exe with Inno Setup. No SDK needed.
cd /d "%~dp0"
if not exist build mkdir build
if not exist assets\FrameHUD.ico powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icon.ps1

"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ^
  /out:build\FrameHUD.exe /win32manifest:app.manifest /win32icon:assets\FrameHUD.ico ^
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Xml.dll ^
  src\*.cs || exit /b 1

set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if exist "%ISCC%" ("%ISCC%" /Q installer\FrameHUD.iss && echo Installer: dist\FrameHUD-Setup.exe) else echo Inno Setup not found - skipped installer.
