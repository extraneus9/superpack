// ShellHelper — persistent native sidecar for Foldernator.
// Talks JSON lines over stdin/stdout. Owns an STA thread with a message loop so
// clipboard, COM shell context menus and Properties dialogs work.
// Built with the .NET Framework csc.exe that ships with Windows (scripts/build-helper.js).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AlvaShell
{
    static class Native
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHGetSetFolderCustomSettings(ref SHFOLDERCUSTOMSETTINGS pfcs, string pszPath, uint dwReadWrite);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, IntPtr dwItem2);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern bool WritePrivateProfileString(string section, string key, string value, string file);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern bool SHObjectProperties(IntPtr hwnd, uint shopObjectType, string pszObjectName, string pszPropertyPage);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHOpenWithDialog(IntPtr hwndParent, ref OPENASINFO poainfo);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);

        [DllImport("shell32.dll")]
        public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);

        [DllImport("shell32.dll")]
        public static extern int SHGetDesktopFolder(out IntPtr ppshf);

        [DllImport("user32.dll")]
        public static extern IntPtr CreatePopupMenu();

        [DllImport("user32.dll")]
        public static extern bool DestroyMenu(IntPtr hMenu);

        [DllImport("user32.dll")]
        public static extern int GetMenuItemCount(IntPtr hMenu);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
        public static extern uint GetWindowPid(IntPtr hWnd, out uint pid);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

        [DllImport("shell32.dll")]
        public static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);

        [DllImport("shell32.dll", EntryPoint = "SHGetFileInfoW")]
        public static extern IntPtr SHGetFileInfoPidl(IntPtr pidl, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

        [DllImport("shell32.dll")]
        public static extern int SHGetKnownFolderIDList(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppidl);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHGetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

        [DllImport("comctl32.dll")]
        public static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, int flags);

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern int GetObject(IntPtr h, int c, ref BITMAP bm);

        [DllImport("gdi32.dll")]
        public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, [Out] byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);

        [DllImport("user32.dll")]
        public static extern uint TrackPopupMenuEx(IntPtr hmenu, uint fuFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern uint GetPrivateProfileString(string section, string key, string def, StringBuilder ret, uint size, string file);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("ole32.dll")]
        public static extern void CoTaskMemFree(IntPtr pv);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool SystemParametersInfo(uint action, uint param, string vparam, uint winIni);

        [DllImport("shell32.dll")]
        public static extern int SHDoDragDrop(IntPtr hwnd, IntPtr pdata, IntPtr pdsrc, uint dwEffect, out uint pdwEffect);

        public const uint FCSM_ICONFILE = 0x10;
        public const uint FCS_FORCEWRITE = 0x2;
        public const int SHCNE_UPDATEITEM = 0x2000;
        public const int SHCNE_UPDATEDIR = 0x1000;
        public const int SHCNE_ASSOCCHANGED = 0x08000000;
        public const uint SHCNF_PATHW = 0x5;
        public const uint SHCNF_FLUSHNOWAIT = 0x3000;
        public const uint SHOP_FILEPATH = 0x2;
        public const uint TPM_RETURNCMD = 0x100;
        public const uint TPM_RIGHTBUTTON = 0x2;
        public const uint CMF_NORMAL = 0x0;
        public const uint CMF_EXPLORE = 0x4;
        public const uint CMF_CANRENAME = 0x10;
        public const uint CMF_EXTENDEDVERBS = 0x100;
        public const uint GCS_VERBW = 0x4;
        public const uint CMIC_MASK_UNICODE = 0x4000;
        public const uint CMIC_MASK_PTINVOKE = 0x20000000;
        public const int SW_SHOWNORMAL = 1;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFOLDERCUSTOMSETTINGS
    {
        public uint dwSize;
        public uint dwMask;
        public IntPtr pvid;
        public IntPtr pszWebViewTemplate;
        public uint cchWebViewTemplate;
        public IntPtr pszWebViewTemplateVersion;
        public IntPtr pszInfoTip;
        public uint cchInfoTip;
        public IntPtr pclsid;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszIconFile;
        public uint cchIconFile;
        public int iIconIndex;
        public IntPtr pszLogo;
        public uint cchLogo;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OPENASINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pcszFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcszClass;
        public int oaifInFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    // INPUT with the keyboard member at the union offset (8 on x64); padded to the size of the largest member.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
        public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public uint biClrUsed; public uint biClrImportant;
        // room for a colour table GetDIBits may write for the 1-bpp mask
        public uint c0, c1;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
        [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CMINVOKECOMMANDINFOEX
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        public IntPtr lpVerb;
        [MarshalAs(UnmanagedType.LPStr)] public string lpParameters;
        [MarshalAs(UnmanagedType.LPStr)] public string lpDirectory;
        public int nShow;
        public uint dwHotKey;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.LPStr)] public string lpTitle;
        public IntPtr lpVerbW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpParametersW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectoryW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpTitleW;
        public POINT ptInvoke;
    }

    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellFolder
    {
        void ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string pszDisplayName, ref uint pchEaten, out IntPtr ppidl, ref uint pdwAttributes);
        void EnumObjects(IntPtr hwnd, int grfFlags, out IntPtr ppenumIDList);
        void BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        void BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
        void CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
        void GetAttributesOf(uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint rgfInOut);
        void GetUIObjectOf(IntPtr hwndOwner, uint cidl, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] IntPtr[] apidl, ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
        void GetDisplayNameOf(IntPtr pidl, uint uFlags, IntPtr pName);
        void SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string pszName, uint uFlags, out IntPtr ppidlOut);
    }

    [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, StringBuilder pszName, uint cchMax);
    }

    [ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IContextMenu2
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, StringBuilder pszName, uint cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
    }

    [ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IContextMenu3
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, StringBuilder pszName, uint cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
        [PreserveSig] int HandleMenuMsg2(uint uMsg, IntPtr wParam, IntPtr lParam, IntPtr plResult);
    }

    // Hidden top-level window: owner for menus/dialogs, routes owner-draw menu messages.
    class HostWindow : NativeWindow
    {
        public IContextMenu2 Cm2;
        public IContextMenu3 Cm3;

        public HostWindow()
        {
            var cp = new CreateParams();
            cp.Caption = "foldernator-shellhelper";
            cp.X = -32000; cp.Y = -32000; cp.Width = 1; cp.Height = 1;
            cp.Style = unchecked((int)0x80000000); // WS_POPUP
            cp.ExStyle = 0x00000080; // WS_EX_TOOLWINDOW
            CreateHandle(cp);
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_INITMENUPOPUP = 0x117, WM_DRAWITEM = 0x2B, WM_MEASUREITEM = 0x2C, WM_MENUCHAR = 0x120;
            if (Cm3 != null && (m.Msg == WM_INITMENUPOPUP || m.Msg == WM_DRAWITEM || m.Msg == WM_MEASUREITEM || m.Msg == WM_MENUCHAR))
            {
                IntPtr res = Marshal.AllocHGlobal(IntPtr.Size);
                try
                {
                    if (Cm3.HandleMenuMsg2((uint)m.Msg, m.WParam, m.LParam, res) == 0)
                    {
                        m.Result = Marshal.ReadIntPtr(res);
                        return;
                    }
                }
                finally { Marshal.FreeHGlobal(res); }
            }
            else if (Cm2 != null && (m.Msg == WM_INITMENUPOPUP || m.Msg == WM_DRAWITEM || m.Msg == WM_MEASUREITEM))
            {
                if (Cm2.HandleMenuMsg((uint)m.Msg, m.WParam, m.LParam) == 0) { m.Result = IntPtr.Zero; return; }
            }
            base.WndProc(ref m);
        }
    }

    static class Program
    {
        static readonly object OutLock = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static HostWindow Host;
        static StreamReader In;
        static StreamWriter Out;
        static SynchronizationContext Ui;

        [STAThread]
        static int Main(string[] args)
        {
            In = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2: menus at the cursor on any monitor
            Application.EnableVisualStyles();
            Host = new HostWindow();
            WindowsFormsSynchronizationContext.AutoInstall = true;
            Ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(Ui);

            var reader = new Thread(ReadLoop) { IsBackground = true };
            reader.Start();
            Send(new Dictionary<string, object> { { "event", "ready" }, { "pid", System.Diagnostics.Process.GetCurrentProcess().Id } });
            Application.Run();
            return 0;
        }

        static void ReadLoop()
        {
            string line;
            while ((line = In.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Dictionary<string, object> msg;
                try { msg = Json.Deserialize<Dictionary<string, object>>(line); }
                catch (Exception e) { Send(new Dictionary<string, object> { { "id", null }, { "ok", false }, { "error", "bad json: " + e.Message } }); continue; }
                var m = msg;
                Ui.Post(_ => Handle(m), null);
            }
            Ui.Post(_ => Application.Exit(), null);
        }

        static void Send(Dictionary<string, object> obj)
        {
            string s = Json.Serialize(obj);
            lock (OutLock) { Out.Write(s); Out.Write('\n'); Out.Flush(); }
        }

        static void Reply(object id, object result) { Send(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } }); }
        static void Fail(object id, string err) { Send(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", err } }); }

        static string Str(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? v.ToString() : null; }
        static int Int(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : 0; }
        static bool Bool(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v is bool && (bool)v; }
        static List<string> Paths(Dictionary<string, object> m)
        {
            var list = new List<string>();
            object v;
            if (m.TryGetValue("paths", out v) && v is IEnumerable)
                foreach (var p in (IEnumerable)v) if (p != null) list.Add(p.ToString());
            return list;
        }

        static List<string> StrList(Dictionary<string, object> m, string k)
        {
            var list = new List<string>();
            object v;
            if (m.TryGetValue(k, out v) && v is IEnumerable && !(v is string))
                foreach (var p in (IEnumerable)v) if (p != null) list.Add(p.ToString());
            return list;
        }

        static void Handle(Dictionary<string, object> m)
        {
            object id = m.ContainsKey("id") ? m["id"] : null;
            string cmd = Str(m, "cmd");
            try
            {
                switch (cmd)
                {
                    case "ping": Reply(id, "pong"); break;
                    case "setFolderStatus": Reply(id, SetFolderStatus(Str(m, "folder"), Str(m, "icon"), Str(m, "status"), Str(m, "color"))); break;
                    case "notify": Notify(Str(m, "path")); Reply(id, true); break;
                    case "clipboardSet": ClipboardSet(Paths(m), Bool(m, "cut")); Reply(id, true); break;
                    case "clipboardGet": Reply(id, ClipboardGet()); break;
                    case "properties": Properties(Paths(m), m.ContainsKey("hwnd") && m["hwnd"] != null ? new IntPtr(Convert.ToInt64(m["hwnd"])) : IntPtr.Zero); Reply(id, true); break;
                    case "openWith": OpenWith(id, Str(m, "path")); break; // replies async
                    case "dragOut": Reply(id, DragOut(Paths(m))); break;
                    case "contextMenu": Reply(id, ContextMenu(Paths(m), Int(m, "x"), Int(m, "y"), Bool(m, "extended"), Bool(m, "dry"))); break;
                    case "drives": Reply(id, Drives()); break;
                    case "quickAccess": Reply(id, QuickAccess()); break;
                    case "portable": Reply(id, Portable()); break;
                    case "shellList": Reply(id, ShellList(Str(m, "path"))); break;
                    case "shellInvoke": Reply(id, ShellInvoke(Str(m, "path"))); break;
                    case "imageCrop": Reply(id, ImageCrop(Str(m, "path"), Int(m, "x"), Int(m, "y"), Int(m, "w"), Int(m, "h"))); break;
                    case "imageRotate": Reply(id, ImageRotate(Str(m, "path"), Str(m, "op"))); break;
                    case "setWallpaper": Reply(id, Native.SystemParametersInfo(0x0014, 0, Str(m, "path"), 0x01 | 0x02)); break; // SPI_SETDESKWALLPAPER, update ini + broadcast
                    case "shellCopy": Reply(id, ShellCopy(Paths(m), Str(m, "to"))); break;
                    case "snipGuard": Reply(id, SnipGuard(Bool(m, "on"))); break;
                    case "snipReplay": SnipReplay(Bool(m, "dry")); Reply(id, true); break;
                    case "snipSimulate": BeginSnip("S"); Reply(id, true); break;
                    case "tree":
                        {
                            string dir = Str(m, "dir");
                            ThreadPool.QueueUserWorkItem(_ => { try { Reply(id, Tree(dir)); } catch (Exception e) { Fail(id, e.GetType().Name + ": " + e.Message); } });
                            break;
                        }
                    case "shellIcon": Reply(id, ShellIcon(Str(m, "path"), Int(m, "size"))); break;
                    case "scan": StartScan(id, Str(m, "sid"), StrList(m, "roots"), StrList(m, "exts"), Int(m, "max")); break;
                    case "captureWindow": Reply(id, CaptureWindow(new IntPtr(Convert.ToInt64(m["hwnd"])), Str(m, "out"))); break;
                    case "list":
                        {
                            string dir = Str(m, "dir");
                            ThreadPool.QueueUserWorkItem(_ => { try { Reply(id, List(dir)); } catch (Exception e) { Fail(id, e.GetType().Name + ": " + e.Message); } });
                            break;
                        }
                    case "search": StartSearch(id, Str(m, "sid"), Str(m, "root"), Str(m, "query"), Bool(m, "hidden")); break;
                    case "searchCancel": CancelSearch(Str(m, "sid")); Reply(id, true); break;
                    case "fileOp": FileOp(id, Str(m, "op"), Paths(m), Str(m, "to"), Bool(m, "renameOnCollision")); break;
                    case "exit": Reply(id, true); Application.Exit(); break;
                    default: Fail(id, "unknown cmd " + cmd); break;
                }
            }
            catch (Exception e) { Fail(id, e.GetType().Name + ": " + e.Message); }
        }

        // ---------- folder status (desktop.ini + custom icon) ----------
        static object SetFolderStatus(string folder, string icon, string status, string color)
        {
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) throw new Exception("folder not found");
            string ini = Path.Combine(folder, "desktop.ini");
            var fcs = new SHFOLDERCUSTOMSETTINGS();
            fcs.dwSize = (uint)Marshal.SizeOf(typeof(SHFOLDERCUSTOMSETTINGS));
            fcs.dwMask = Native.FCSM_ICONFILE;
            fcs.pszIconFile = string.IsNullOrEmpty(icon) ? null : icon;
            fcs.cchIconFile = 0;
            fcs.iIconIndex = 0;
            int hr = Native.SHGetSetFolderCustomSettings(ref fcs, folder, Native.FCS_FORCEWRITE);

            if (string.IsNullOrEmpty(icon))
            {
                if (File.Exists(ini))
                {
                    Native.WritePrivateProfileString(".ShellClassInfo", "IconResource", null, ini);
                    Native.WritePrivateProfileString(".ShellClassInfo", "IconFile", null, ini);
                    Native.WritePrivateProfileString(".ShellClassInfo", "IconIndex", null, ini);
                    Native.WritePrivateProfileString("alva", null, null, ini);
                    CleanupIni(ini);
                }
            }
            else
            {
                if (hr != 0 || !File.Exists(ini))
                {
                    // Fallback: write the keys ourselves and mark the folder.
                    if (!File.Exists(ini)) { File.WriteAllText(ini, "", new UnicodeEncoding(false, true)); }
                    Native.WritePrivateProfileString(".ShellClassInfo", "IconResource", icon + ",0", ini);
                    File.SetAttributes(ini, FileAttributes.Hidden | FileAttributes.System);
                    var di = new DirectoryInfo(folder);
                    di.Attributes |= FileAttributes.ReadOnly;
                }
                Native.WritePrivateProfileString("alva", "Status", string.IsNullOrEmpty(status) ? null : status, ini);
                Native.WritePrivateProfileString("alva", "Color", string.IsNullOrEmpty(color) ? null : color, ini);
            }
            Notify(folder);
            return new Dictionary<string, object> { { "hr", hr }, { "ini", File.Exists(ini) } };
        }

        static void CleanupIni(string ini)
        {
            // Delete desktop.ini if nothing meaningful is left in it.
            string text;
            try { text = File.ReadAllText(ini); } catch { return; }
            foreach (var raw in text.Split('\n'))
            {
                var l = raw.Trim().Trim('﻿');
                if (l.Length == 0 || l.StartsWith(";") || l.StartsWith("[")) continue;
                return; // has a real key
            }
            try { File.SetAttributes(ini, FileAttributes.Normal); File.Delete(ini); } catch { }
        }

        static void Notify(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            Native.SHChangeNotify(Native.SHCNE_UPDATEITEM, Native.SHCNF_PATHW | Native.SHCNF_FLUSHNOWAIT, path, IntPtr.Zero);
            string parent = Path.GetDirectoryName(path.TrimEnd('\\'));
            if (!string.IsNullOrEmpty(parent))
                Native.SHChangeNotify(Native.SHCNE_UPDATEDIR, Native.SHCNF_PATHW | Native.SHCNF_FLUSHNOWAIT, parent, IntPtr.Zero);
        }

        // ---------- clipboard (interop with Explorer and every app) ----------
        static void ClipboardSet(List<string> paths, bool cut)
        {
            var files = new StringCollection();
            foreach (var p in paths) files.Add(p);
            var data = new DataObject();
            data.SetFileDropList(files);
            var effect = new MemoryStream(BitConverter.GetBytes(cut ? 2 : 5)); // DROPEFFECT_MOVE : COPY|LINK
            data.SetData("Preferred DropEffect", effect);
            Clipboard.SetDataObject(data, true, 5, 50);
        }

        static object ClipboardGet()
        {
            var result = new Dictionary<string, object> { { "paths", new string[0] }, { "cut", false } };
            if (!Clipboard.ContainsFileDropList()) return result;
            var list = Clipboard.GetFileDropList();
            var arr = new string[list.Count];
            list.CopyTo(arr, 0);
            result["paths"] = arr;
            var obj = Clipboard.GetData("Preferred DropEffect") as MemoryStream;
            if (obj != null)
            {
                var b = new byte[4];
                obj.Read(b, 0, 4);
                result["cut"] = (BitConverter.ToInt32(b, 0) & 2) == 2;
            }
            return result;
        }

        // ---------- dialogs ----------
        // Owned by Foldernator's window, then raised: the dialog belongs to this background process, which Windows
        // won't let activate a window, so it opened BEHIND the app and Alt+Enter looked like it did nothing.
        // Fix: wait for the new dialog, borrow the foreground thread's input, and bring the dialog forward.
        static void Properties(List<string> paths, IntPtr owner)
        {
            var before = DialogsOfThisProcess();
            foreach (var p in paths) Native.SHObjectProperties(owner, Native.SHOP_FILEPATH, p, null);
            new Thread(() =>
            {
                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(50);
                    var fresh = DialogsOfThisProcess().FindAll(h => !before.Contains(h));
                    if (fresh.Count == 0) continue;
                    IntPtr fg = Native.GetForegroundWindow();
                    uint fgThread = Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
                    uint me = Native.GetCurrentThreadId();
                    if (fgThread != me) Native.AttachThreadInput(me, fgThread, true);
                    foreach (var h in fresh) { Native.BringWindowToTop(h); Native.SetForegroundWindow(h); }
                    if (fgThread != me) Native.AttachThreadInput(me, fgThread, false);
                    return;
                }
            }) { IsBackground = true }.Start();
        }

        static List<IntPtr> DialogsOfThisProcess()
        {
            var list = new List<IntPtr>();
            uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            Native.EnumWindows((h, l) =>
            {
                uint pid;
                Native.GetWindowPid(h, out pid);
                if (pid != self || !Native.IsWindowVisible(h)) return true;
                var cls = new StringBuilder(64);
                Native.GetClassName(h, cls, 64);
                if (cls.ToString() == "#32770") list.Add(h);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        static void OpenWith(object id, string path)
        {
            var t = new Thread(() =>
            {
                try
                {
                    var info = new OPENASINFO { pcszFile = path, pcszClass = null, oaifInFlags = 0x1 | 0x4 }; // ALLOW_REGISTRATION | EXEC
                    int hr = Native.SHOpenWithDialog(IntPtr.Zero, ref info);
                    Reply(id, hr);
                }
                catch (Exception e) { Fail(id, e.Message); }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        // ---------- drag out (Explorer's own drag) ----------
        // Started when the pointer leaves Foldernator with items held: a shell data object + SHDoDragDrop, so the
        // drop works in any app (Resolve, CapCut, Explorer, a browser…) and Windows draws its thumbnail drag image.
        // The button is already down; borrowing the foreground thread's input lets OLE take over the mouse capture.
        static object DragOut(List<string> paths)
        {
            if (paths.Count == 0) throw new Exception("no paths");
            var pidls = new List<IntPtr>();
            IntPtr parentPtr = IntPtr.Zero, dataPtr = IntPtr.Zero;
            IShellFolder parent = null;
            uint fgThread = 0, me = Native.GetCurrentThreadId();
            try
            {
                var childPidls = new List<IntPtr>();
                Guid iidSF = typeof(IShellFolder).GUID;
                foreach (var p in paths)
                {
                    IntPtr pidl; uint attrs;
                    if (Native.SHParseDisplayName(p, IntPtr.Zero, out pidl, 0, out attrs) != 0) throw new Exception("parse failed: " + p);
                    pidls.Add(pidl);
                    IntPtr sfPtr, last;
                    if (Native.SHBindToParent(pidl, ref iidSF, out sfPtr, out last) != 0) throw new Exception("bind failed");
                    if (parent == null) { parentPtr = sfPtr; parent = (IShellFolder)Marshal.GetObjectForIUnknown(sfPtr); }
                    else Marshal.Release(sfPtr);
                    childPidls.Add(last);
                }
                Guid iidDO = new Guid("0000010e-0000-0000-C000-000000000046");
                parent.GetUIObjectOf(Host.Handle, (uint)childPidls.Count, childPidls.ToArray(), ref iidDO, IntPtr.Zero, out dataPtr);
                IntPtr fg = Native.GetForegroundWindow();
                fgThread = Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
                if (fgThread != 0 && fgThread != me) Native.AttachThreadInput(me, fgThread, true);
                uint effect;
                int hr = Native.SHDoDragDrop(Host.Handle, dataPtr, IntPtr.Zero, 1 | 2 | 4, out effect); // copy | move | link
                return new Dictionary<string, object> { { "hr", hr }, { "effect", (long)effect } };
            }
            finally
            {
                if (fgThread != 0 && fgThread != me) Native.AttachThreadInput(me, fgThread, false);
                if (dataPtr != IntPtr.Zero) Marshal.Release(dataPtr);
                if (parent != null) Marshal.ReleaseComObject(parent);
                if (parentPtr != IntPtr.Zero) Marshal.Release(parentPtr);
                foreach (var p in pidls) Native.CoTaskMemFree(p);
            }
        }

        // ---------- the real Windows context menu ("Show more options") ----------
        static object ContextMenu(List<string> paths, int x, int y, bool extended, bool dry)
        {
            if (paths.Count == 0) throw new Exception("no paths");
            var pidls = new List<IntPtr>();
            IntPtr parentPtr = IntPtr.Zero, cmPtr = IntPtr.Zero, hmenu = IntPtr.Zero;
            IShellFolder parent = null;
            IContextMenu cm = null;
            try
            {
                var childPidls = new List<IntPtr>();
                Guid iidSF = typeof(IShellFolder).GUID;
                foreach (var p in paths)
                {
                    IntPtr pidl; uint attrs;
                    int hr = Native.SHParseDisplayName(p, IntPtr.Zero, out pidl, 0, out attrs);
                    if (hr != 0) throw new Exception("parse failed: " + p);
                    pidls.Add(pidl);
                    IntPtr sfPtr, last;
                    hr = Native.SHBindToParent(pidl, ref iidSF, out sfPtr, out last);
                    if (hr != 0) throw new Exception("bind failed");
                    if (parent == null) { parentPtr = sfPtr; parent = (IShellFolder)Marshal.GetObjectForIUnknown(sfPtr); }
                    else Marshal.Release(sfPtr);
                    childPidls.Add(last);
                }
                Guid iidCM = typeof(IContextMenu).GUID;
                parent.GetUIObjectOf(Host.Handle, (uint)childPidls.Count, childPidls.ToArray(), ref iidCM, IntPtr.Zero, out cmPtr);
                cm = (IContextMenu)Marshal.GetObjectForIUnknown(cmPtr);
                Host.Cm2 = cm as IContextMenu2;
                Host.Cm3 = cm as IContextMenu3;

                hmenu = Native.CreatePopupMenu();
                const uint first = 1, last2 = 0x7FFF;
                uint flags = Native.CMF_NORMAL | Native.CMF_EXPLORE | Native.CMF_CANRENAME | (extended ? Native.CMF_EXTENDEDVERBS : 0);
                cm.QueryContextMenu(hmenu, 0, first, last2, flags);
                if (dry)
                {
                    var labels = new List<string>();
                    int n = Native.GetMenuItemCount(hmenu);
                    for (int i = 0; i < n; i++)
                    {
                        var sb = new StringBuilder(256);
                        Native.GetMenuString(hmenu, (uint)i, sb, 256, 0x400); // MF_BYPOSITION
                        if (sb.Length > 0) labels.Add(sb.ToString().Replace("&", ""));
                    }
                    return new Dictionary<string, object> { { "dry", true }, { "labels", labels } };
                }

                // A background process may not own the foreground; borrow input from the foreground thread.
                IntPtr fg = Native.GetForegroundWindow();
                uint fgThread = Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
                uint me = Native.GetCurrentThreadId();
                if (fgThread != me) Native.AttachThreadInput(me, fgThread, true);
                Native.SetForegroundWindow(Host.Handle);
                if (fgThread != me) Native.AttachThreadInput(me, fgThread, false);

                uint chosen = Native.TrackPopupMenuEx(hmenu, Native.TPM_RETURNCMD | Native.TPM_RIGHTBUTTON, x, y, Host.Handle, IntPtr.Zero);
                Native.PostMessage(Host.Handle, 0, IntPtr.Zero, IntPtr.Zero);
                if (chosen == 0) return new Dictionary<string, object> { { "chosen", false } };

                var verbSb = new StringBuilder(256);
                string verb = null;
                if (cm.GetCommandString((UIntPtr)(chosen - first), Native.GCS_VERBW, IntPtr.Zero, verbSb, 256) == 0) verb = verbSb.ToString();

                // Actions our own view should perform (the shell can't rename/delete inside a foreign view).
                if (verb == "rename" || verb == "delete" || verb == "cut" || verb == "copy" || verb == "paste")
                    return new Dictionary<string, object> { { "chosen", true }, { "action", verb } };

                var ici = new CMINVOKECOMMANDINFOEX();
                ici.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFOEX));
                ici.fMask = Native.CMIC_MASK_UNICODE | Native.CMIC_MASK_PTINVOKE;
                ici.hwnd = Host.Handle;
                ici.lpVerb = (IntPtr)(chosen - first);
                ici.lpVerbW = (IntPtr)(chosen - first);
                ici.nShow = Native.SW_SHOWNORMAL;
                ici.ptInvoke = new POINT { x = x, y = y };
                ici.lpDirectoryW = Path.GetDirectoryName(paths[0]);
                int ihr = cm.InvokeCommand(ref ici);
                return new Dictionary<string, object> { { "chosen", true }, { "verb", verb }, { "hr", ihr } };
            }
            finally
            {
                Host.Cm2 = null; Host.Cm3 = null;
                if (hmenu != IntPtr.Zero) Native.DestroyMenu(hmenu);
                if (cm != null) Marshal.ReleaseComObject(cm);
                if (cmPtr != IntPtr.Zero) Marshal.Release(cmPtr);
                if (parent != null) Marshal.ReleaseComObject(parent);
                if (parentPtr != IntPtr.Zero) Marshal.Release(parentPtr);
                foreach (var p in pidls) Native.CoTaskMemFree(p);
            }
        }

        // ---------- listing (one FindFirstFile pass: attributes, sizes, times, status) ----------
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        static long Ms(DateTime utc) { return (long)(utc - Epoch).TotalMilliseconds; }

        static string ReadIni(string section, string key, string file)
        {
            var sb = new StringBuilder(512);
            Native.GetPrivateProfileString(section, key, "", sb, 512, file);
            return sb.ToString();
        }

        static Dictionary<string, object> Entry(FileSystemInfo fsi, bool withStatus)
        {
            var a = fsi.Attributes;
            bool isDir = (a & FileAttributes.Directory) != 0;
            var e = new Dictionary<string, object>();
            e["n"] = fsi.Name;
            e["p"] = fsi.FullName;
            e["d"] = isDir;
            e["s"] = isDir ? 0L : ((FileInfo)fsi).Length;
            e["m"] = Ms(fsi.LastWriteTimeUtc);
            e["c"] = Ms(fsi.CreationTimeUtc);
            if ((a & FileAttributes.Hidden) != 0) e["h"] = true;
            if ((a & FileAttributes.System) != 0) e["sys"] = true;
            if ((a & FileAttributes.ReparsePoint) != 0) e["l"] = true;
            if ((a & (FileAttributes.Offline | (FileAttributes)0x400000 | (FileAttributes)0x40000)) != 0) e["o"] = true;
            if (withStatus && isDir && (a & (FileAttributes.ReadOnly | FileAttributes.System)) != 0)
            {
                string ini = Path.Combine(fsi.FullName, "desktop.ini");
                if (File.Exists(ini))
                {
                    string st = ReadIni("alva", "Status", ini);
                    string col = ReadIni("alva", "Color", ini);
                    if (st.Length > 0) e["st"] = st;
                    if (col.Length > 0) e["col"] = col;
                }
            }
            return e;
        }

        static object List(string dir)
        {
            var di = new DirectoryInfo(dir);
            var items = new List<object>();
            foreach (var fsi in di.EnumerateFileSystemInfos("*", SearchOption.TopDirectoryOnly))
            {
                try { items.Add(Entry(fsi, true)); } catch { }
            }
            return new Dictionary<string, object> { { "dir", di.FullName }, { "items", items } };
        }

        // ---------- recursive search (streams batches, cancelable) ----------
        static readonly Dictionary<string, CancellationTokenSource> Searches = new Dictionary<string, CancellationTokenSource>();

        static void StartSearch(object id, string sid, string root, string query, bool hidden)
        {
            var cts = new CancellationTokenSource();
            lock (Searches) { Searches[sid] = cts; }
            Reply(id, true);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var tok = cts.Token;
                var batch = new List<object>();
                int total = 0, scanned = 0;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                string q = (query ?? "").ToLowerInvariant();
                bool wildcard = q.Contains("*") || q.Contains("?");
                System.Text.RegularExpressions.Regex rx = null;
                if (wildcard) rx = new System.Text.RegularExpressions.Regex("^" + System.Text.RegularExpressions.Regex.Escape(q).Replace("\\*", ".*").Replace("\\?", ".") + "$");
                var stack = new Stack<string>();
                stack.Push(root);
                try
                {
                    while (stack.Count > 0 && !tok.IsCancellationRequested && total < 5000)
                    {
                        string cur = stack.Pop();
                        IEnumerable<FileSystemInfo> entries;
                        try { entries = new DirectoryInfo(cur).EnumerateFileSystemInfos(); } catch { continue; }
                        try
                        {
                            foreach (var fsi in entries)
                            {
                                if (tok.IsCancellationRequested) break;
                                scanned++;
                                var a = fsi.Attributes;
                                if (!hidden && (a & FileAttributes.Hidden) != 0) continue;
                                bool isDir = (a & FileAttributes.Directory) != 0;
                                if (isDir && (a & FileAttributes.ReparsePoint) == 0) stack.Push(fsi.FullName);
                                string name = fsi.Name.ToLowerInvariant();
                                bool hit = wildcard ? rx.IsMatch(name) : name.Contains(q);
                                if (hit) { batch.Add(Entry(fsi, true)); total++; }
                                if (batch.Count >= 200 || (batch.Count > 0 && sw.ElapsedMilliseconds > 150))
                                {
                                    Send(new Dictionary<string, object> { { "event", "search" }, { "sid", sid }, { "items", batch }, { "scanned", scanned } });
                                    batch = new List<object>();
                                    sw.Restart();
                                }
                            }
                        }
                        catch { }
                    }
                }
                finally
                {
                    if (batch.Count > 0) Send(new Dictionary<string, object> { { "event", "search" }, { "sid", sid }, { "items", batch }, { "scanned", scanned } });
                    Send(new Dictionary<string, object> { { "event", "searchDone" }, { "sid", sid }, { "total", total }, { "scanned", scanned }, { "canceled", tok.IsCancellationRequested }, { "capped", total >= 5000 } });
                    lock (Searches) { Searches.Remove(sid); }
                }
            });
        }

        static void CancelSearch(string sid)
        {
            lock (Searches) { CancellationTokenSource c; if (sid != null && Searches.TryGetValue(sid, out c)) c.Cancel(); }
        }

        // ---------- copy / move / delete through the Windows shell (native progress + conflict dialogs) ----------
        static void FileOp(object id, string op, List<string> paths, string to, bool renameOnCollision)
        {
            var t = new Thread(() =>
            {
                try
                {
                    const uint FO_MOVE = 1, FO_COPY = 2, FO_DELETE = 3;
                    const ushort FOF_RENAMEONCOLLISION = 0x8, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOCONFIRMMKDIR = 0x200, FOF_WANTNUKEWARNING = 0x4000;
                    var s = new SHFILEOPSTRUCT();
                    s.hwnd = IntPtr.Zero;
                    s.pFrom = string.Join("\0", paths.ToArray()) + "\0";
                    ushort flags = FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR;
                    switch (op)
                    {
                        case "copy": s.wFunc = FO_COPY; s.pTo = to + "\0"; if (renameOnCollision) flags |= FOF_RENAMEONCOLLISION; break;
                        case "move": s.wFunc = FO_MOVE; s.pTo = to + "\0"; if (renameOnCollision) flags |= FOF_RENAMEONCOLLISION; break;
                        case "recycle": s.wFunc = FO_DELETE; flags |= FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING; break;
                        case "delete": s.wFunc = FO_DELETE; flags = FOF_NOCONFIRMMKDIR; break; // shell asks "permanently delete?"
                        default: throw new Exception("bad op " + op);
                    }
                    s.fFlags = flags;
                    int hr = Native.SHFileOperation(ref s);
                    Reply(id, new Dictionary<string, object> { { "hr", hr }, { "aborted", s.fAnyOperationsAborted } });
                }
                catch (Exception e) { Fail(id, e.Message); }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        // ---------- QA: capture a (possibly off-screen) window with full DWM content ----------
        static object CaptureWindow(IntPtr hwnd, string outPath)
        {
            RECT r;
            Native.GetWindowRect(hwnd, out r);
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            using (var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var g = System.Drawing.Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    Native.PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT
                    g.ReleaseHdc(hdc);
                }
                bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
            }
            return new Dictionary<string, object> { { "w", w }, { "h", h } };
        }

        // ---------- every file under a folder (relative path + size), for the full Drive comparison ----------
        static object Tree(string root)
        {
            var files = new List<object>();
            var dirs = new List<string>();
            root = root.TrimEnd('\\');
            var stack = new Stack<KeyValuePair<string, string>>();
            stack.Push(new KeyValuePair<string, string>(root, ""));
            while (stack.Count > 0)
            {
                var cur = stack.Pop();
                IEnumerable<FileSystemInfo> entries;
                try { entries = new DirectoryInfo(cur.Key).EnumerateFileSystemInfos(); } catch { continue; }
                try
                {
                    foreach (var fsi in entries)
                    {
                        var a = fsi.Attributes;
                        string rel = cur.Value.Length == 0 ? fsi.Name : cur.Value + "/" + fsi.Name;
                        if ((a & FileAttributes.Directory) != 0)
                        {
                            if ((a & FileAttributes.ReparsePoint) != 0) continue;
                            dirs.Add(rel);
                            stack.Push(new KeyValuePair<string, string>(fsi.FullName, rel));
                        }
                        else files.Add(new object[] { rel, ((FileInfo)fsi).Length });
                    }
                }
                catch { }
            }
            return new Dictionary<string, object> { { "files", files }, { "dirs", dirs } };
        }

        // ---------- screenshot guard (only while live glass is on) ----------
        // Live glass hides the window from capture. Screenshots are taken the instant Win+Shift+S / PrintScreen
        // is pressed, so we hold that key for a moment, let alva freeze its glass and become capturable,
        // then hand the exact key press back to Windows. Fails open: the key is always released within 300 ms.
        static IntPtr hook = IntPtr.Zero;
        static Native.LowLevelKeyboardProc hookProc; // keep the delegate alive
        static bool snipPending, swallowS, snipWin, snipShift, snipAlt;
        static string snipKey;
        static System.Windows.Forms.Timer failOpen, watch;
        static int watchTicks, goneTicks;
        static bool seenClip, dryRun;

        static bool KeyDown(int vk) { return (Native.GetAsyncKeyState(vk) & 0x8000) != 0; }

        static object SnipGuard(bool on)
        {
            if (on && hook == IntPtr.Zero)
            {
                hookProc = HookProc;
                hook = Native.SetWindowsHookEx(13, hookProc, Native.GetModuleHandle(null), 0);
            }
            else if (!on && hook != IntPtr.Zero)
            {
                Native.UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
            }
            return new Dictionary<string, object> { { "active", hook != IntPtr.Zero } };
        }

        static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                bool injected = (k.flags & 0x10) != 0;
                int msg = wParam.ToInt32();
                bool down = msg == 0x100 || msg == 0x104;
                if (!injected)
                {
                    bool win = KeyDown(0x5B) || KeyDown(0x5C), shift = KeyDown(0x10);
                    if (k.vkCode == 0x53 && (win && shift || swallowS))
                    {
                        if (down && !snipPending) { snipWin = win; snipShift = shift; snipAlt = false; BeginSnip("S"); }
                        if (!down) swallowS = false;
                        else swallowS = true;
                        return (IntPtr)1;
                    }
                    if (k.vkCode == 0x2C) // PrintScreen (+Alt / +Win)
                    {
                        if (down && !snipPending) { snipWin = win; snipShift = shift; snipAlt = KeyDown(0x12); BeginSnip("PRT"); }
                        return (IntPtr)1;
                    }
                }
            }
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }

        static void BeginSnip(string key)
        {
            snipPending = true;
            snipKey = key;
            if (failOpen == null) { failOpen = new System.Windows.Forms.Timer { Interval = 300 }; failOpen.Tick += (s, e) => { failOpen.Stop(); if (snipPending) SnipReplay(false); }; }
            failOpen.Stop(); failOpen.Start();
            Send(new Dictionary<string, object> { { "event", "snip" }, { "key", key } });
        }

        static KEYBDINPUT Key(ushort vk, bool up) { return new KEYBDINPUT { wVk = vk, dwFlags = up ? 2u : 0u }; }

        static void SnipReplay(bool dry)
        {
            if (!snipPending) return;
            snipPending = false;
            if (failOpen != null) failOpen.Stop();
            dryRun = dry;
            if (!dry)
            {
                var seq = new List<KEYBDINPUT>();
                bool winHeld = KeyDown(0x5B) || KeyDown(0x5C), shiftHeld = KeyDown(0x10), altHeld = KeyDown(0x12);
                bool addWin = snipWin && !winHeld, addShift = snipShift && !shiftHeld, addAlt = snipAlt && !altHeld;
                if (addWin) seq.Add(Key(0x5B, false));
                if (addShift) seq.Add(Key(0x10, false));
                if (addAlt) seq.Add(Key(0x12, false));
                ushort main = snipKey == "S" ? (ushort)0x53 : (ushort)0x2C;
                seq.Add(Key(main, false));
                seq.Add(Key(main, true));
                if (addAlt) seq.Add(Key(0x12, true));
                if (addShift) seq.Add(Key(0x10, true));
                if (addWin) seq.Add(Key(0x5B, true));
                var inputs = new INPUT[seq.Count];
                for (int i = 0; i < seq.Count; i++) inputs[i] = new INPUT { type = 1, ki = seq[i] };
                Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            }
            // Watch the capture UI; report when it is gone so alva can go back to live glass.
            watchTicks = 0; goneTicks = 0; seenClip = false;
            if (watch == null) { watch = new System.Windows.Forms.Timer { Interval = 150 }; watch.Tick += WatchTick; }
            watch.Stop(); watch.Start();
        }

        static void WatchTick(object sender, EventArgs e)
        {
            watchTicks++;
            bool clip = false;
            if (!dryRun)
            {
                try
                {
                    uint pid;
                    Native.GetWindowPid(Native.GetForegroundWindow(), out pid);
                    string name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                    clip = name.Contains("screenclipping") || name.Contains("snippingtool") || name.Contains("screensketch");
                }
                catch { }
            }
            if (clip) { seenClip = true; goneTicks = 0; }
            else if (seenClip) goneTicks++;
            bool done = (seenClip && goneTicks >= 3) || (!seenClip && watchTicks >= (dryRun ? 3 : 16)) || watchTicks >= 600;
            if (done)
            {
                watch.Stop();
                Send(new Dictionary<string, object> { { "event", "snipDone" } });
            }
        }

        // ---------- real shell icons (per folder/drive/file), 16-256 px with alpha ----------
        static readonly Guid IID_IImageList = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");

        // Known folders (Downloads, Desktop…) get their special icon from their identity, not their path.
        static readonly Guid[] KnownFolders = {
            new Guid("374DE290-123F-4565-9164-39C4925E467B"), new Guid("B4BFCC3A-DB2C-424C-B029-7FE99A87C641"),
            new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7"), new Guid("4BD8D571-6D19-48D3-BE97-422220080E43"),
            new Guid("33E28130-4E1E-4676-835A-98395C3BC3BB"), new Guid("18989B1D-99B5-455B-841C-AB7C74E4DDFC"),
        };
        static Dictionary<string, Guid> knownByPath;

        static Guid? KnownFolderFor(string path)
        {
            if (knownByPath == null)
            {
                knownByPath = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
                foreach (var g in KnownFolders)
                {
                    var id = g;
                    IntPtr p;
                    if (Native.SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out p) == 0)
                    {
                        knownByPath[Marshal.PtrToStringUni(p).TrimEnd('\\')] = g;
                        Native.CoTaskMemFree(p);
                    }
                }
            }
            Guid found;
            return knownByPath.TryGetValue(path.TrimEnd('\\'), out found) ? (Guid?)found : null;
        }

        static string ShellIcon(string path, int size)
        {
            var info = new SHFILEINFO();
            const uint SHGFI_SYSICONINDEX = 0x4000, SHGFI_PIDL = 0x8;
            IntPtr r = IntPtr.Zero;
            var known = KnownFolderFor(path);
            if (known.HasValue)
            {
                var id = known.Value;
                IntPtr pidl;
                if (Native.SHGetKnownFolderIDList(ref id, 0, IntPtr.Zero, out pidl) == 0)
                {
                    r = Native.SHGetFileInfoPidl(pidl, 0, ref info, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_SYSICONINDEX | SHGFI_PIDL);
                    Native.CoTaskMemFree(pidl);
                }
            }
            if (r == IntPtr.Zero) r = Native.SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_SYSICONINDEX);
            if (r == IntPtr.Zero)
            {
                // Offline drive / missing path (e.g. an unplugged H:\): ask for the generic icon by type instead.
                const uint SHGFI_USEFILEATTRIBUTES = 0x10, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_NORMAL = 0x80;
                bool dir = path.EndsWith("\\") || Path.GetExtension(path).Length == 0;
                r = Native.SHGetFileInfo(path, dir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL, ref info, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES);
            }
            if (r == IntPtr.Zero) throw new Exception("no icon");
            int list = size <= 16 ? 1 : size <= 32 ? 0 : size <= 48 ? 2 : 4; // SMALL, LARGE, EXTRALARGE, JUMBO
            Guid iid = IID_IImageList;
            IntPtr himl;
            if (Native.SHGetImageList(list, ref iid, out himl) != 0 || himl == IntPtr.Zero) throw new Exception("no image list");
            IntPtr hIcon = Native.ImageList_GetIcon(himl, info.iIcon, 0x1);
            if (hIcon == IntPtr.Zero) throw new Exception("no hicon");
            try { return IconToPng(hIcon, size >= 256); }
            finally { Native.DestroyIcon(hIcon); }
        }

        static byte[] Bits(IntPtr hbm, int w, int h)
        {
            var bmi = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32, biCompression = 0 };
            var bits = new byte[w * h * 4];
            IntPtr dc = Native.GetDC(IntPtr.Zero);
            Native.GetDIBits(dc, hbm, 0, (uint)h, bits, ref bmi, 0);
            Native.ReleaseDC(IntPtr.Zero, dc);
            return bits;
        }

        static string IconToPng(IntPtr hIcon, bool cropJumbo)
        {
            ICONINFO ii;
            if (!Native.GetIconInfo(hIcon, out ii)) throw new Exception("GetIconInfo failed");
            try
            {
                var bm = new BITMAP();
                Native.GetObject(ii.hbmColor, Marshal.SizeOf(typeof(BITMAP)), ref bm);
                int w = bm.bmWidth, h = bm.bmHeight;
                byte[] px = Bits(ii.hbmColor, w, h);
                bool alpha = false;
                for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) { alpha = true; break; }
                if (!alpha)
                {
                    byte[] mask = Bits(ii.hbmMask, w, h);
                    for (int i = 0; i < px.Length; i += 4) px[i + 3] = (byte)(mask[i] == 0 ? 255 : 0);
                }
                int cw = w, ch = h;
                if (cropJumbo)
                {
                    // Icons without a 256 px frame are drawn small in the top-left corner of the jumbo canvas.
                    int maxX = 0, maxY = 0;
                    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
                    if (maxX < w / 2 && maxY < h / 2) { cw = ch = Math.Max(maxX, maxY) + 1; }
                }
                using (var bmp = new System.Drawing.Bitmap(cw, ch, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, cw, ch), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    for (int y = 0; y < ch; y++) Marshal.Copy(px, y * w * 4, data.Scan0 + y * data.Stride, cw * 4);
                    bmp.UnlockBits(data);
                    using (var ms = new MemoryStream())
                    {
                        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
            finally
            {
                if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
                if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
            }
        }

        // ---------- Windows Quick access: pinned folders + recent files ----------
        // Portable devices (Fire tablet, phones, cameras over MTP) have no drive letter: they only exist in the
        // shell namespace under This PC. Listed, browsed and opened through Shell.Application.
        static object Portable()
        {
            var list = new List<object>();
            dynamic sh = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
            dynamic ns = sh.NameSpace(17);
            if (ns == null) return list;
            foreach (dynamic it in ns.Items())
            {
                try
                {
                    if (it.IsFileSystem) continue;
                    list.Add(new Dictionary<string, object> { { "name", (string)it.Name }, { "path", (string)it.Path }, { "type", (string)it.Type } });
                }
                catch { }
            }
            return list;
        }

        static dynamic ShellFolder(string path)
        {
            dynamic sh = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
            dynamic ns = sh.NameSpace(path);
            if (ns != null) return ns;
            // Deeper device folders can't be opened by path string: walk down from the parent and take its item's folder.
            int cut = path.LastIndexOf((char)92);
            if (cut > 2)
            {
                try
                {
                    foreach (dynamic it in ShellFolder(path.Substring(0, cut)).Items())
                        if (string.Equals((string)it.Path, path, StringComparison.OrdinalIgnoreCase) && it.IsFolder) return it.GetFolder;
                }
                catch { }
            }
            throw new Exception("This device isn't available (unlocked and set to file transfer?)");
        }

        static object ShellList(string path)
        {
            var list = new List<object>();
            foreach (dynamic it in ShellFolder(path).Items())
            {
                try
                {
                    long size = 0, mod = 0;
                    try { size = Convert.ToInt64(it.Size); } catch { }
                    try { mod = (long)(((DateTime)it.ModifyDate).ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds; } catch { }
                    list.Add(new Dictionary<string, object> { { "n", (string)it.Name }, { "p", (string)it.Path }, { "d", (bool)it.IsFolder }, { "s", size }, { "m", mod }, { "t", (string)it.Type } });
                }
                catch { }
            }
            return list;
        }

        // Copy files to a device folder (Fire, phone…) or from a device folder to a normal one. Sources that are
        // device paths are resolved to their shell items; plain paths go in as-is.
        static object ShellCopy(List<string> paths, string to)
        {
            dynamic dest = ShellFolder(to);
            int n = 0;
            foreach (var p in paths)
            {
                object src = p;
                if (p.StartsWith("::"))
                {
                    int cut = p.LastIndexOf((char)92);
                    src = null;
                    foreach (dynamic it in ShellFolder(p.Substring(0, cut)).Items())
                        if (string.Equals((string)it.Path, p, StringComparison.OrdinalIgnoreCase)) { src = it; break; }
                    if (src == null) continue;
                }
                dest.CopyHere(src, 0); // 0 = Windows shows progress and asks on conflicts
                n++;
            }
            return n;
        }

        // Image viewer edits (like Windows Photos): rotate 90° either way or flip, written back to the same file.
        // Loaded through a memory copy so the file isn't locked; metadata is kept and EXIF orientation reset to 1.
        static object ImageRotate(string path, string op)
        {
            byte[] bytes = File.ReadAllBytes(path);
            System.Drawing.Imaging.ImageFormat fmt;
            using (var ms = new MemoryStream(bytes))
            using (var img = System.Drawing.Image.FromStream(ms))
            {
                fmt = img.RawFormat;
                var t = op == "left" ? System.Drawing.RotateFlipType.Rotate270FlipNone
                      : op == "flipH" ? System.Drawing.RotateFlipType.RotateNoneFlipX
                      : op == "flipV" ? System.Drawing.RotateFlipType.RotateNoneFlipY
                      : System.Drawing.RotateFlipType.Rotate90FlipNone;
                img.RotateFlip(t);
                foreach (var pi in img.PropertyItems)
                    if (pi.Id == 0x0112) { pi.Value = new byte[] { 1, 0 }; img.SetPropertyItem(pi); }
                var tmp = path + ".fntmp";
                if (fmt.Guid == System.Drawing.Imaging.ImageFormat.Jpeg.Guid)
                {
                    var codec = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), c => c.FormatID == fmt.Guid);
                    var ep = new System.Drawing.Imaging.EncoderParameters(1);
                    ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 96L);
                    img.Save(tmp, codec, ep);
                }
                else img.Save(tmp, fmt.Guid == System.Drawing.Imaging.ImageFormat.MemoryBmp.Guid ? System.Drawing.Imaging.ImageFormat.Png : fmt);
                File.Copy(tmp, path, true);
                File.Delete(tmp);
                return new Dictionary<string, object> { { "w", img.Width }, { "h", img.Height } };
            }
        }

        static object ImageCrop(string path, int x, int y, int w, int h)
        {
            byte[] bytes = File.ReadAllBytes(path);
            using (var ms = new MemoryStream(bytes))
            using (var img = System.Drawing.Image.FromStream(ms))
            {
                var fmt = img.RawFormat;
                x = Math.Max(0, Math.Min(x, img.Width - 1)); y = Math.Max(0, Math.Min(y, img.Height - 1));
                w = Math.Max(1, Math.Min(w, img.Width - x)); h = Math.Max(1, Math.Min(h, img.Height - y));
                using (var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    bmp.SetResolution(img.HorizontalResolution, img.VerticalResolution);
                    using (var g = System.Drawing.Graphics.FromImage(bmp))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                        g.DrawImage(img, new System.Drawing.Rectangle(0, 0, w, h), new System.Drawing.Rectangle(x, y, w, h), System.Drawing.GraphicsUnit.Pixel);
                    }
                    foreach (var pi in img.PropertyItems) { try { if (pi.Id == 0x0112) pi.Value = new byte[] { 1, 0 }; if (pi.Id != 0x5001 && pi.Id != 0x5002) bmp.SetPropertyItem(pi); } catch { } }
                    var tmp = path + ".fntmp";
                    if (fmt.Guid == System.Drawing.Imaging.ImageFormat.Jpeg.Guid)
                    {
                        var codec = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), c => c.FormatID == fmt.Guid);
                        var ep = new System.Drawing.Imaging.EncoderParameters(1);
                        ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 96L);
                        bmp.Save(tmp, codec, ep);
                    }
                    else bmp.Save(tmp, fmt.Guid == System.Drawing.Imaging.ImageFormat.MemoryBmp.Guid ? System.Drawing.Imaging.ImageFormat.Png : fmt);
                    File.Copy(tmp, path, true);
                    File.Delete(tmp);
                    return new Dictionary<string, object> { { "w", w }, { "h", h } };
                }
            }
        }

        static object ShellInvoke(string path)
        {
            int cut = path.LastIndexOf('\\');
            dynamic ns = ShellFolder(cut > 0 ? path.Substring(0, cut) : path);
            foreach (dynamic it in ns.Items())
                if (string.Equals((string)it.Path, path, StringComparison.OrdinalIgnoreCase)) { it.InvokeVerb(); return true; }
            throw new Exception("not found");
        }

        static object QuickAccess()
        {
            var list = new List<object>();
            var t = Type.GetTypeFromProgID("Shell.Application");
            dynamic sh = Activator.CreateInstance(t);
            dynamic ns = sh.NameSpace("shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}");
            if (ns == null) return list;
            dynamic items = ns.Items();
            int n = items.Count;
            for (int i = 0; i < n; i++)
            {
                dynamic it = items.Item(i);
                if (it == null) continue;
                string path = "", name = "";
                bool pinned = false, folder = false;
                try { path = it.Path; name = it.Name; } catch { continue; }
                try { object v = it.ExtendedProperty("System.Home.IsPinned"); pinned = v is bool && (bool)v; } catch { }
                try { folder = it.IsFolder; } catch { }
                list.Add(new Dictionary<string, object> { { "name", name }, { "path", path }, { "pinned", pinned }, { "folder", folder } });
            }
            return list;
        }

        // ---------- media scan for the Gallery (streams like search) ----------
        static void StartScan(object id, string sid, List<string> roots, List<string> exts, int max)
        {
            var cts = new CancellationTokenSource();
            lock (Searches) { Searches[sid] = cts; }
            Reply(id, true);
            if (max <= 0) max = 5000;
            var extSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var e in exts) extSet.Add(e.StartsWith(".") ? e : "." + e);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var tok = cts.Token;
                var batch = new List<object>();
                int total = 0, scanned = 0;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var stack = new Stack<string>();
                for (int i = roots.Count - 1; i >= 0; i--) if (Directory.Exists(roots[i])) stack.Push(roots[i]);
                try
                {
                    while (stack.Count > 0 && !tok.IsCancellationRequested && total < max)
                    {
                        string cur = stack.Pop();
                        IEnumerable<FileSystemInfo> entries;
                        try { entries = new DirectoryInfo(cur).EnumerateFileSystemInfos(); } catch { continue; }
                        try
                        {
                            foreach (var fsi in entries)
                            {
                                if (tok.IsCancellationRequested || total >= max) break;
                                scanned++;
                                var a = fsi.Attributes;
                                if ((a & FileAttributes.Hidden) != 0) continue;
                                if ((a & FileAttributes.Directory) != 0) { if ((a & FileAttributes.ReparsePoint) == 0) stack.Push(fsi.FullName); continue; }
                                if (!extSet.Contains(fsi.Extension)) continue;
                                batch.Add(Entry(fsi, false)); total++;
                                if (batch.Count >= 300 || sw.ElapsedMilliseconds > 200)
                                {
                                    Send(new Dictionary<string, object> { { "event", "search" }, { "sid", sid }, { "items", batch }, { "scanned", scanned } });
                                    batch = new List<object>();
                                    sw.Restart();
                                }
                            }
                        }
                        catch { }
                    }
                }
                finally
                {
                    if (batch.Count > 0) Send(new Dictionary<string, object> { { "event", "search" }, { "sid", sid }, { "items", batch }, { "scanned", scanned } });
                    Send(new Dictionary<string, object> { { "event", "searchDone" }, { "sid", sid }, { "total", total }, { "scanned", scanned }, { "canceled", tok.IsCancellationRequested }, { "capped", total >= max } });
                    lock (Searches) { Searches.Remove(sid); }
                }
            });
        }

        // ---------- drives ----------
        static object Drives()
        {
            var list = new List<object>();
            foreach (var d in DriveInfo.GetDrives())
            {
                var e = new Dictionary<string, object>();
                e["path"] = d.Name;
                e["type"] = d.DriveType.ToString();
                e["ready"] = d.IsReady;
                if (d.IsReady)
                {
                    try { e["label"] = d.VolumeLabel; } catch { e["label"] = ""; }
                    try { e["total"] = d.TotalSize; e["free"] = d.AvailableFreeSpace; e["format"] = d.DriveFormat; } catch { }
                }
                list.Add(e);
            }
            return list;
        }
    }
}
