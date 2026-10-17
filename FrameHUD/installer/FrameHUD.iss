; FrameHUD installer (Inno Setup 6). Built by build.cmd -> dist\FrameHUD-Setup.exe

#define AppName "FrameHUD"
#define AppVersion "1.0.0"

[Setup]
AppId={{7E4C2B1A-3F5D-4C8E-9A61-2B7F0D4E8C13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=FrameHUD-Setup
SetupIconFile=..\assets\FrameHUD.ico
UninstallDisplayIcon={app}\FrameHUD.exe
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start FrameHUD automatically when Windows starts"; GroupDescription: "Startup:"

[Files]
Source: "..\build\FrameHUD.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\FrameHUD.exe"
Name: "{autoprograms}\{#AppName} Settings"; Filename: "{app}\FrameHUD.exe"; Parameters: "--settings"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\FrameHUD.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\FrameHUD.exe"; Parameters: "--autostart on"; Tasks: autostart; Flags: runhidden waituntilterminated
Filename: "{app}\FrameHUD.exe"; Parameters: "--autostart off"; Tasks: not autostart; Flags: runhidden waituntilterminated
Filename: "{app}\FrameHUD.exe"; Description: "Launch FrameHUD now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\FrameHUD.exe"; Parameters: "--exit"; Flags: runhidden waituntilterminated; RunOnceId: "ExitApp"
Filename: "{app}\FrameHUD.exe"; Parameters: "--autostart off"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveAutostart"

[Code]
// Ask a running copy to quit before its exe gets replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\FrameHUD.exe');
  if FileExists(Exe) then
    Exec(Exe, '--exit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
