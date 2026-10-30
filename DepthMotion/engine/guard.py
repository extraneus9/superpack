"""Keeps DepthMotion a good neighbour: the PC must stay responsive while it works — without asking anyone to close
their apps. The heavy work lives on the graphics card; RAM only passes data through.

RAM: Windows runs with RAM nearly full on purpose and moves memory nobody is touching (background tabs) to its page
file on disk. That's normal, and every app relies on it. What actually hurts a PC is THRASHING: Windows having to read
memory back from disk non-stop — that's the freeze. So the guard watches that, not "free RAM":
  plan(...)    can the job fit in what Windows can still commit (RAM + page file)? Only a PC that is genuinely out of
               memory is refused.
  check()      during the job: if the PC is actually stalling (a 50 ms nap waking up seconds late) or RAM is truly
               empty, it PAUSES until things calm down, and only stops if that lasts.
VRAM: be_polite() caps the job to the VRAM that's free minus a margin, so it never spills into system RAM.
One heavy job at a time on this PC (one_job). No extra packages: Windows' own calls through ctypes.
"""
import ctypes
import os
import sys
import threading
import time

FLOOR_GB = 0.15          # RAM truly empty: pause
PAUSE_LIMIT_S = 120      # how long to wait for the PC to calm down before stopping
COMMIT_MARGIN_GB = 2.0   # left in Windows' commit (RAM + page file) for everything else
VRAM_MARGIN_GB = 1.5     # left on the card for the desktop / video playback
BELOW_NORMAL = 0x00004000


class LowMemory(RuntimeError):
    pass


class _MEMSTAT(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def _mem():
    m = _MEMSTAT(); m.dwLength = ctypes.sizeof(_MEMSTAT)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m


def free_gb():
    return _mem().ullAvailPhys / 2 ** 30 if sys.platform == "win32" else 64.0


def total_gb():
    return _mem().ullTotalPhys / 2 ** 30 if sys.platform == "win32" else 64.0


def commit_room_gb():
    """What Windows can still hand out, counting its page file on disk (the real limit, not "free RAM")."""
    return _mem().ullAvailPageFile / 2 ** 30 if sys.platform == "win32" else 64.0


def reserve_gb():
    """Shown in the app's gauge: the RAM a job never takes for itself (the rest of the PC keeps working beside it)."""
    return FLOOR_GB


# ---- is the PC actually stalling? A small high-priority thread asks for 50 ms naps and times them: when Windows is
# thrashing (and everything on the PC with it), those naps take seconds. Page-read counters can't tell that apart from an
# app simply loading its libraries from disk; this can. ----
_lag = {"last": [], "thread": None}


def _watch_lag():
    try:
        ctypes.windll.kernel32.SetThreadPriority(ctypes.windll.kernel32.GetCurrentThread(), 2)  # THREAD_PRIORITY_HIGHEST
    except Exception:
        pass
    while True:
        t0 = time.perf_counter()
        time.sleep(0.05)
        _lag["last"] = (_lag["last"] + [time.perf_counter() - t0 - 0.05])[-6:]
        time.sleep(0.45)


def _start_lag():
    if not _lag["thread"]:
        _lag["thread"] = threading.Thread(target=_watch_lag, daemon=True); _lag["thread"].start()


def lag_s():
    """How late the last nap woke up (seconds): ~0 on a healthy PC, seconds when it's stalling."""
    _start_lag()
    return _lag["last"][-1] if _lag["last"] else 0.0


def stuck():
    """The PC is in trouble: RAM truly empty, or it is stalling (two naps in a row woke up more than a second late)."""
    _start_lag()
    if free_gb() < FLOOR_GB:
        return True
    last = _lag["last"][-2:]
    return len(last) == 2 and min(last) > 1.0


def gpu_room():
    """Free VRAM in GB (0 without a card)."""
    try:
        import torch
        if torch.cuda.is_available():
            free, _ = torch.cuda.mem_get_info(0)
            return free / 2 ** 30
    except Exception:
        pass
    return 0.0


def check(where="", notify=None):
    """PC in trouble? Pause until it calms down (the person is probably using it); stop only if it doesn't."""
    if not stuck():
        return
    t0, calm = time.time(), 0
    while calm < 3:
        if time.time() - t0 > PAUSE_LIMIT_S:
            raise LowMemory(f"Stopped to keep your PC responsive: it stayed short of memory for {PAUSE_LIMIT_S // 60} "
                            f"minutes{(' (' + where + ')') if where else ''}. Try again in a moment.")
        if notify:
            notify("Paused for a moment - your PC is busy making room. It carries on by itself.")
        time.sleep(1)
        calm = 0 if stuck() else calm + 1


def be_polite():
    """Below-normal priority for this process (ffmpeg and Blender inherit it). VRAM: everything free minus a margin."""
    if sys.platform == "win32":
        try:
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL)
        except Exception:
            pass
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info(0)
            share = max(0.3, min(0.95, (free / 2 ** 30 - VRAM_MARGIN_GB) / (total / 2 ** 30)))
            torch.cuda.set_per_process_memory_fraction(share, 0)
    except Exception:
        pass


def need_gb(frames, w, h, people=False, location=False, tracker_on_gpu=True):
    """Rough peak RAM a job adds on top of the open app. The frames sit in a scratch file on disk (memory-mapped, so
    Windows hands that memory back to other apps whenever they need it) and the model sits on the graphics card."""
    px = frames * w * h
    if location:  # the new-location path needs full-size depth (per-pixel distances for the people)
        gb = px * (4 + 4 + 4 + 2) / 2 ** 30    # raw + aligned + normalised + half-size copy
        gb += px * 2 / 2 ** 30                 # merged depth
    else:         # extract: depth stays at the model's own size (~518 px short side) until each frame is written
        model_px = frames * 518 * 518 * max(w, h) / max(min(w, h), 1)
        gb = model_px * (4 + 4 + 4 + 2) / 2 ** 30
    if people:
        gb += px / 2 ** 30 + (0 if tracker_on_gpu else 0.6)  # label maps (+ the tracker's chunk when it lives in RAM)
    return gb + 0.5                             # one window of frames on its way to the card, writers, working copies


def plan(frames, src_w, src_h, max_res=1280, people=False, location=False):
    """-> the working long-side resolution. Full resolution whenever the job fits in what Windows can still commit (RAM +
    its page file: background apps' idle memory moves to disk to make room, as for any app). A lower size only when
    even that is short; a clear refusal only when the PC is genuinely out of memory."""
    room = commit_room_gb() - COMMIT_MARGIN_GB
    on_gpu = gpu_room() > 6
    for res in (max_res, 960, 720, 540):
        s = min(1.0, res / max(src_w, src_h))
        if need_gb(frames, src_w * s, src_h * s, people, location, on_gpu) <= room:
            return res
    raise LowMemory("Your PC is out of memory right now (even counting Windows' page file). "
                    "Trim the clip shorter or close something heavy, then try again.")


class one_job:
    """A lock file in the DepthMotion home: one heavy job at a time on this PC. Waits for the other to finish."""

    def __init__(self, home, say=None, wait_s=3600):
        self.path = os.path.join(home, "job.lock"); self.say = say; self.wait_s = wait_s; self.fd = None

    def _alive(self, pid):
        if sys.platform != "win32":
            return False
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong(); ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code)); ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        t0 = time.time()
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode()); return self
            except FileExistsError:
                try:
                    pid = int(open(self.path).read().strip() or 0)
                except (OSError, ValueError):
                    pid = 0
                if not pid or not self._alive(pid):  # left behind by a job that died
                    try:
                        os.remove(self.path)
                    except OSError:
                        pass
                    continue
                if time.time() - t0 > self.wait_s:
                    raise RuntimeError("Another DepthMotion job is still running. Try again when it's done.")
                if self.say:
                    self.say(0.0, "Waiting for another DepthMotion job to finish")
                time.sleep(2)

    def __exit__(self, *a):
        try:
            os.close(self.fd); os.remove(self.path)
        except OSError:
            pass


# ---------- what the app shows before you press anything ----------
FRIENDLY = {"chrome": "Google Chrome", "brave": "Brave", "msedge": "Microsoft Edge", "firefox": "Firefox", "claude": "Claude",
            "code": "VS Code", "resolve": "DaVinci Resolve", "blender": "Blender", "photoshop": "Photoshop", "afterfx": "After Effects",
            "adobe premiere pro": "Premiere Pro", "discord": "Discord", "spotify": "Spotify", "slack": "Slack", "obs64": "OBS",
            "chrome-headless-shell": "Headless Chrome (automation)", "node": "Node.js tools", "remotion": "Remotion",
            "steam": "Steam", "steamwebhelper": "Steam", "teams": "Teams", "ms-teams": "Teams", "whatsapp": "WhatsApp", "notion": "Notion",
            "figma": "Figma", "capcut": "CapCut", "explorer": "File Explorer", "electron": "Electron apps",
            "msedgewebview2": "Edge WebView (app windows)", "python": "Python tools", "pythonw": "Python tools",
            "phoneexperiencehost": "Phone Link", "onedrive": "OneDrive"}
SYSTEM = {"system", "registry", "memory compression", "svchost", "msmpeng", "dwm", "csrss", "lsass", "services", "wininit",
          "smss", "fontdrvhost", "searchhost", "searchindexer", "runtimebroker", "audiodg", "spoolsv", "wmiprvse", "ctfmon",
          "sihost", "taskhostw", "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "lockapp", "idle",
          "securityhealthservice", "nvcontainer", "nvdisplay.container", "conhost", "dllhost", "winlogon", "secure system"}


def top_apps(n=6, min_gb=0.3):
    """The biggest RAM users you could close (system parts of Windows left out). Read-only."""
    import csv
    import subprocess
    out = subprocess.run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, creationflags=0x08000000).stdout
    sums, counts = {}, {}
    me = os.getpid()
    for row in csv.reader(out.splitlines()):
        if len(row) < 5:
            continue
        name = row[0].lower().removesuffix(".exe")
        if name in SYSTEM or (name.startswith("python") and int(row[1] or 0) == me):
            continue
        kb = int("".join(c for c in row[4] if c.isdigit()) or 0)
        sums[name] = sums.get(name, 0) + kb / 2 ** 20; counts[name] = counts.get(name, 0) + 1
    rows = sorted(sums.items(), key=lambda x: -x[1])
    return [{"app": FRIENDLY.get(k, k.replace("-", " ").title()), "gb": round(v, 1), "windows": counts[k]}
            for k, v in rows if v >= min_gb][:n]


def snapshot():
    """RAM + VRAM right now (for the gauge)."""
    vfree, vtotal = 0.0, 0.0
    try:
        import torch
        if torch.cuda.is_available():
            f, t = torch.cuda.mem_get_info(0); vfree, vtotal = f / 2 ** 30, t / 2 ** 30
    except Exception:
        pass
    return {"ram_free": round(free_gb(), 1), "ram_total": round(total_gb(), 1), "reserve": round(reserve_gb(), 1),
            "floor": FLOOR_GB, "vram_free": round(vfree, 1), "vram_total": round(vtotal, 1)}


def preflight(frames, src_w, src_h, people=False, location=False, max_res=1280):
    """What a job would need, at which working size, and whether it can start now - without starting it.
    tight: it fits, but RAM is nearly full, so Windows will move some idle memory (background tabs) to disk first."""
    room = commit_room_gb() - COMMIT_MARGIN_GB
    on_gpu = gpu_room() > 6
    full = None
    for res in (max_res, 960, 720, 540):
        s = min(1.0, res / max(src_w, src_h))
        need = need_gb(frames, src_w * s, src_h * s, people, location, on_gpu)
        full = full or need
        if need <= room:
            return {"ok": True, "tight": free_gb() < need + 0.5, "res": res, "need": round(need, 1), "need_full": round(full, 1),
                    "room": round(free_gb(), 1), "reduced": res < max_res, "tracker_on_gpu": on_gpu}
    return {"ok": False, "res": None, "need": round(need, 1), "need_full": round(full, 1), "room": round(room, 1),
            "short_by": round(need - room, 1), "tracker_on_gpu": on_gpu}
