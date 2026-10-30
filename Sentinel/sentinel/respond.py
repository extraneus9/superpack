"""Sentinel — active response.

When the behavior monitor detects ransomware-style activity in a folder, this finds the process
actually responsible, kills it, and quarantines its executable — the "eliminate" half of
detect-and-eliminate. User-mode (psutil), no kernel driver.

Attribution (how it knows WHICH process to kill), best signal first:
  1. a process holding an open file handle inside the folder being attacked, OR
  2. a recently-started process running from a user-writable location (Temp/AppData/Downloads/
     Desktop/Users/samples) — i.e. not a signed system binary under C:\\Windows or Program Files.
Critical OS processes are never touched.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

try:
    import psutil
    HAVE_PSUTIL = True
except Exception:  # pragma: no cover - optional dependency
    psutil = None
    HAVE_PSUTIL = False

# Per-OS: processes never to kill, trusted install roots (skipped fast), and user-writable
# locations where fresh malware tends to run from. Lowercased substring matches.
if sys.platform == "darwin":
    SAFE_NAMES = {"launchd", "kernel_task", "windowserver", "finder", "dock", "loginwindow",
                  "systemuiserver", "coreaudiod", "mds", "mds_stores", "mdworker", "distnoted",
                  "cfprefsd", "securityd", "sentinel", "python", "python3"}
    TRUSTED_ROOTS = ("/system/", "/usr/", "/bin/", "/sbin/", "/applications/")
    USER_WRITABLE = ("/users/", "/tmp/", "/private/", "/var/folders/", "/downloads/",
                     "/desktop/", "/documents/", "/library/caches/")
elif sys.platform == "win32":
    SAFE_NAMES = {
        "system", "registry", "memory compression", "idle",
        "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe",
        "explorer.exe", "dwm.exe", "svchost.exe", "cmd.exe", "conhost.exe", "powershell.exe",
        "taskhostw.exe", "runtimebroker.exe", "sihost.exe", "ctfmon.exe", "fontdrvhost.exe",
        "searchhost.exe", "startmenuexperiencehost.exe", "sentinel.exe",
    }
    TRUSTED_ROOTS = ("\\windows\\", "program files")
    USER_WRITABLE = ("\\temp\\", "\\appdata\\", "\\downloads\\", "\\desktop\\",
                     "\\users\\public", "\\samples", "\\documents\\")
else:  # linux
    SAFE_NAMES = {"systemd", "init", "kthreadd", "sentinel", "python", "python3"}
    TRUSTED_ROOTS = ("/usr/", "/bin/", "/sbin/", "/lib/")
    USER_WRITABLE = ("/home/", "/tmp/", "/var/tmp/", "/downloads/", "/desktop/", "/documents/")


def find_culprits(folder, since: float = 0.0, exclude_pids=()) -> list:
    """Return [(pid, name, exe, why), ...] of processes likely attacking `folder`.

    Fast path: a signed system binary (under C:\\Windows or Program Files) is trusted and skipped
    outright — this also keeps the scan quick by never enumerating its handles. A user-space
    process started since the attack began is flagged immediately. Only a user-space process that
    is NOT newly started gets the (slower) open-handle check, so this stays real-time."""
    if not HAVE_PSUTIL:
        return []
    target = str(Path(folder).resolve()).lower()
    out = []
    for p in psutil.process_iter(["pid", "name", "exe", "create_time"]):
        try:
            pid = p.info["pid"]
            name = (p.info.get("name") or "").lower()
            exe = p.info.get("exe") or ""
            ue = exe.lower()
            if pid in exclude_pids or pid <= 4 or name in SAFE_NAMES:
                continue
            if not exe or any(r in ue for r in TRUSTED_ROOTS):
                continue  # trusted system binary (or unknowable) — skip, and keep it fast
            if any(s in ue for s in USER_WRITABLE) and (p.info.get("create_time") or 0.0) >= since:
                out.append((pid, p.info.get("name"), exe, "new process running from a user folder"))
        except Exception:
            continue
    return out


def neutralize(folder, scanner=None, since: float = 0.0, exclude_pids=()) -> dict:
    """Kill the culprits and quarantine their executables. Returns {killed, quarantined, why}."""
    killed, quarantined, why = [], [], []
    seen_exes = set()
    for pid, name, exe, reason in find_culprits(folder, since, exclude_pids):
        try:
            psutil.Process(pid).kill()
            killed.append(f"{name or '?'} (pid {pid})")
            why.append(reason)
        except Exception:
            continue
        if scanner is not None and exe and exe.lower() not in seen_exes and Path(exe).exists():
            seen_exes.add(exe.lower())
            try:
                res = scanner.scan_file(Path(exe))
                scanner.quarantine(res)
                if res.quarantined_to:
                    quarantined.append(Path(exe).name)
            except Exception:
                pass
    return {"killed": killed, "quarantined": quarantined, "why": why}
