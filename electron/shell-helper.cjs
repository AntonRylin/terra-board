// A long-running Windows PowerShell process for the parts of Explorer that
// Electron does not offer: the shell's own large icons and thumbnails, file
// attributes (hidden, system, online-only) and the file clipboard that Explorer
// reads and writes. Each request is one line: an id, an operation and base64
// UTF-8 arguments, so paths in any language survive the console. Requests run
// one at a time, attribute and clipboard requests before queued icons.
const { spawn } = require('node:child_process');

const csharp = String.raw`
using System;
using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class TerraShell
{
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SIZE { public int cx; public int cy; }
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAP
    {
        public int bmType, bmWidth, bmHeight, bmWidthBytes;
        public ushort bmPlanes, bmBitsPixel;
        public IntPtr bmBits;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, out BITMAP bm);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

    static string Arg(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
    static string Out(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)); }

    public static string Handle(string line)
    {
        string id = "0";
        try
        {
            string[] parts = line.Split('\t');
            id = parts[0];
            switch (parts[1])
            {
                case "icon": return id + "\tok\t" + Png(Arg(parts[2]), int.Parse(parts[3]), int.Parse(parts[4]));
                case "attributes": return id + "\tok\t" + Out(Attributes(Arg(parts[2])));
                case "clip-set": SetClip(Arg(parts[2]), parts[3] == "1"); return id + "\tok\t";
                case "clip-get": return id + "\tok\t" + Out(GetClip());
                case "desktops": return id + "\tok\t" + Out(TerraDesktops.List());
                case "focus": TerraDesktops.Focus(long.Parse(parts[2]), int.Parse(parts[3])); return id + "\tok\t";
                case "switch": TerraDesktops.Switch(int.Parse(parts[2])); return id + "\tok\t";
                case "close": TerraDesktops.Close(long.Parse(parts[2])); return id + "\tok\t";
                case "dock": TerraDesktops.Dock(long.Parse(parts[2]), long.Parse(parts[3]), int.Parse(parts[4]), int.Parse(parts[5]), int.Parse(parts[6]), int.Parse(parts[7]), parts[8] == "1"); return id + "\tok\t";
                case "undock": TerraDesktops.Undock(long.Parse(parts[2])); return id + "\tok\t";
                case "size": TerraDesktops.Size(long.Parse(parts[2]), int.Parse(parts[3]), int.Parse(parts[4])); return id + "\tok\t";
                case "ping": return id + "\tok\t";
            }
            return id + "\terr\t" + Out("Unknown operation");
        }
        catch (Exception e)
        {
            return id + "\terr\t" + Out(e.Message);
        }
    }

    // flags 0: a thumbnail when Windows has one, otherwise the icon (as Explorer shows).
    static string Png(string path, int size, int flags)
    {
        IShellItemImageFactory factory;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
        IntPtr hbm;
        int hr;
        try { hr = factory.GetImage(new SIZE { cx = size, cy = size }, flags, out hbm); }
        finally { Marshal.ReleaseComObject(factory); }
        if (hr != 0) throw new Exception("No picture for this item (0x" + hr.ToString("x8") + ")");
        try
        {
            BITMAP bm;
            GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), out bm);
            int w = bm.bmWidth, h = Math.Abs(bm.bmHeight), stride = bm.bmWidthBytes;
            if (bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32) throw new Exception("Unexpected bitmap");
            byte[] px = new byte[stride * h];
            Marshal.Copy(bm.bmBits, px, 0, px.Length);
            // Thumbnails of photos come without alpha (all zero): they are opaque.
            bool alpha = false;
            for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) { alpha = true; break; }
            using (var bmp = new Bitmap(w, h, alpha ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppRgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, bmp.PixelFormat);
                for (int y = 0; y < h; y++)
                {
                    int src = (bm.bmHeight > 0 ? h - 1 - y : y) * stride;
                    Marshal.Copy(px, src, data.Scan0 + y * data.Stride, w * 4);
                }
                bmp.UnlockBits(data);
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
        finally { DeleteObject(hbm); }
    }

    // name:attributes (hex) for every entry, separated by | (neither may appear in a name).
    static string Attributes(string dir)
    {
        var sb = new StringBuilder();
        foreach (var info in new DirectoryInfo(dir).EnumerateFileSystemInfos())
        {
            if (sb.Length > 0) sb.Append('|');
            sb.Append(info.Name).Append(':').Append(((int)info.Attributes).ToString("x"));
        }
        return sb.ToString();
    }

    static void SetClip(string paths, bool cut)
    {
        var list = new StringCollection();
        foreach (var p in paths.Split('|')) if (p.Length > 0) list.Add(p);
        var data = new DataObject();
        data.SetFileDropList(list);
        // Explorer reads this to tell Cut (move) from Copy.
        data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(cut ? 2 : 5)));
        Clipboard.SetDataObject(data, true, 5, 100);
    }

    // "1|" for cut or "0|" for copy, then the paths; empty without files.
    static string GetClip()
    {
        if (!Clipboard.ContainsFileDropList()) return "";
        var list = Clipboard.GetFileDropList();
        bool cut = false;
        var effect = Clipboard.GetData("Preferred DropEffect") as MemoryStream;
        if (effect != null && effect.Length >= 4)
        {
            var b = new byte[4];
            effect.Read(b, 0, 4);
            int value = BitConverter.ToInt32(b, 0);
            cut = (value & 2) != 0 && (value & 1) == 0;
        }
        var paths = new string[list.Count];
        list.CopyTo(paths, 0);
        return (cut ? "1|" : "0|") + string.Join("|", paths);
    }
}

// Virtual desktops and the windows open on each, as Task View shows them.
// Which desktop a window is on comes from the documented IVirtualDesktopManager;
// the desktops, their order and names from the registry. Switching uses the
// Ctrl+Win+Left/Right keys, since Windows has no public way to switch.
public static class TerraDesktops
{
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out int onCurrent);
        [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid id);
        [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, ref Guid id);
    }
    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    class VirtualDesktopManagerClass { }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";

    static string ProcessPath(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
        }
        finally { CloseHandle(h); }
    }

    // An app's own name ("Google Chrome"), from its file's version information.
    static readonly System.Collections.Generic.Dictionary<string, string> appNames =
        new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    static string AppName(string exe)
    {
        if (exe.Length == 0) return "";
        string name;
        if (appNames.TryGetValue(exe, out name)) return name;
        try { name = System.Diagnostics.FileVersionInfo.GetVersionInfo(exe).FileDescription; } catch { name = null; }
        if (string.IsNullOrWhiteSpace(name)) name = Path.GetFileNameWithoutExtension(exe);
        appNames[exe] = name.Trim();
        return name.Trim();
    }

    static System.Collections.Generic.List<Guid> DesktopIds(Microsoft.Win32.RegistryKey key)
    {
        var ids = new System.Collections.Generic.List<Guid>();
        var bytes = key == null ? null : key.GetValue("VirtualDesktopIDs") as byte[];
        if (bytes != null)
            for (int i = 0; i + 16 <= bytes.Length; i += 16)
            {
                var b = new byte[16];
                Array.Copy(bytes, i, b, 0, 16);
                ids.Add(new Guid(b));
            }
        return ids;
    }

    static Guid CurrentId(Microsoft.Win32.RegistryKey key)
    {
        var bytes = key == null ? null : key.GetValue("CurrentVirtualDesktop") as byte[];
        if (bytes == null)
        {
            var session = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\" + System.Diagnostics.Process.GetCurrentProcess().SessionId + @"\VirtualDesktops");
            if (session != null) bytes = session.GetValue("CurrentVirtualDesktop") as byte[];
        }
        return bytes != null && bytes.Length == 16 ? new Guid(bytes) : Guid.Empty;
    }

    public static string List()
    {
        PerMonitor();
        var manager = (IVirtualDesktopManager)new VirtualDesktopManagerClass();
        var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key);
        var ids = DesktopIds(key);
        var current = CurrentId(key);
        var foreground = GetForegroundWindow();
        var windows = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            int length = GetWindowTextLength(h);
            if (length == 0) return true;
            // The windows Alt+Tab lists: no tool windows or owned popups.
            int ex = GetWindowLong(h, -20);
            bool app = (ex & 0x40000) != 0;
            if (!app && ((ex & 0x80) != 0 || GetWindow(h, 4) != IntPtr.Zero)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            string className = cls.ToString();
            if (className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd") return true;
            int cloaked = 0;
            DwmGetWindowAttribute(h, 14, out cloaked, 4);
            int onCurrent = 1;
            manager.IsWindowOnCurrentVirtualDesktop(h, out onCurrent);
            // Windows on other desktops are hidden by the shell; anything else hidden
            // (by an app, or a suspended app on this desktop) is not a window you can see.
            if (cloaked != 0 && (cloaked != 2 || onCurrent != 0)) return true;
            Guid desktop;
            if (manager.GetWindowDesktopId(h, out desktop) != 0) desktop = Guid.Empty;
            var title = new StringBuilder(length + 1);
            GetWindowText(h, title, title.Capacity);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string exe = ProcessPath(pid);
            // Store apps run inside ApplicationFrameHost; their own process draws the content.
            if (exe.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            {
                IntPtr core = FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
                if (core != IntPtr.Zero)
                {
                    uint corePid;
                    GetWindowThreadProcessId(core, out corePid);
                    var corePath = ProcessPath(corePid);
                    if (corePath.Length > 0) exe = corePath;
                }
            }
            windows.Add(new System.Collections.Generic.Dictionary<string, object> {
                { "id", h.ToInt64().ToString() },
                { "title", title.ToString() },
                { "exe", exe },
                { "app", AppName(exe) },
                { "desktop", desktop == Guid.Empty ? "" : desktop.ToString() },
                { "minimized", IsIconic(h) },
                { "focused", h == foreground },
                { "width", VisibleSize(h, true) },
                { "height", VisibleSize(h, false) },
            });
            return true;
        }, IntPtr.Zero);
        // Windows lists no desktops until a second one was made: take them from the windows.
        if (ids.Count == 0)
        {
            if (current != Guid.Empty) ids.Add(current);
            foreach (var w in windows)
            {
                Guid g;
                if (Guid.TryParse((string)w["desktop"], out g) && !ids.Contains(g)) ids.Add(g);
            }
        }
        string fallbackWallpaper = "";
        var desk = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop");
        if (desk != null) fallbackWallpaper = desk.GetValue("WallPaper") as string ?? "";
        var desktops = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>();
        for (int i = 0; i < ids.Count; i++)
        {
            var sub = key == null ? null : key.OpenSubKey(@"Desktops\{" + ids[i].ToString() + "}");
            string name = sub == null ? null : sub.GetValue("Name") as string;
            string wallpaper = sub == null ? null : sub.GetValue("Wallpaper") as string;
            desktops.Add(new System.Collections.Generic.Dictionary<string, object> {
                { "id", ids[i].ToString() },
                { "name", string.IsNullOrEmpty(name) ? "Desktop " + (i + 1) : name },
                { "wallpaper", string.IsNullOrEmpty(wallpaper) ? fallbackWallpaper : wallpaper },
            });
        }
        var result = new System.Collections.Generic.Dictionary<string, object> {
            { "current", current == Guid.Empty ? "" : current.ToString() },
            { "desktops", desktops },
            { "windows", windows },
        };
        return new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Serialize(result);
    }

    // Ctrl+Win+Right (or Left), steps times: the next or previous desktop.
    public static void Switch(int steps)
    {
        byte arrow = steps > 0 ? (byte)0x27 : (byte)0x25;
        for (int i = 0; i < Math.Min(20, Math.Abs(steps)); i++)
        {
            keybd_event(0x11, 0, 0, UIntPtr.Zero);
            keybd_event(0x5B, 0, 0, UIntPtr.Zero);
            keybd_event(arrow, 0, 1, UIntPtr.Zero);
            keybd_event(arrow, 0, 1 | 2, UIntPtr.Zero);
            keybd_event(0x5B, 0, 2, UIntPtr.Zero);
            keybd_event(0x11, 0, 2, UIntPtr.Zero);
            System.Threading.Thread.Sleep(260);
        }
    }

    static int VisibleSize(IntPtr h, bool width)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) return 0;
        return width ? r.Right - r.Left : r.Bottom - r.Top;
    }

    // Brings a window to the front (restored if minimized), after moving to its desktop.
    public static void Focus(long id, int steps)
    {
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        if (steps != 0) Switch(steps);
        if (IsIconic(h)) ShowWindow(h, 9);
        // Windows lets the process that just pressed a key bring a window forward.
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        if (!SetForegroundWindow(h)) SwitchToThisWindow(h, true);
    }

    // App frames: the real window placed over its frame on the board while
    // someone uses it, owned by Terra's window so it stays above it, and put
    // back where it was (and as it was) afterwards.
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
    struct Home { public RECT Rect; public bool Maximized; }
    static readonly System.Collections.Generic.Dictionary<long, Home> homes = new System.Collections.Generic.Dictionary<long, Home>();

    // Real pixels on every screen, whatever this process was started as.
    static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

    // Places a window so what you see of it (without the invisible resize
    // borders Windows adds around most windows) fills the rectangle exactly.
    static void PlaceVisible(IntPtr h, int x, int y, int width, int height, uint flags)
    {
        SetWindowPos(h, IntPtr.Zero, x, y, width, height, flags);
        RECT outer, visible;
        if (!GetWindowRect(h, out outer) || DwmGetWindowAttribute(h, 9, out visible, Marshal.SizeOf(typeof(RECT))) != 0) return;
        int left = visible.Left - outer.Left, top = visible.Top - outer.Top;
        int right = outer.Right - visible.Right, bottom = outer.Bottom - visible.Bottom;
        if (left == 0 && top == 0 && right == 0 && bottom == 0 && outer.Left == x && outer.Top == y) return;
        SetWindowPos(h, IntPtr.Zero, x - left, y - top, width + left + right, height + top + bottom, flags | 0x0010);
    }

    // x, y, width and height are physical screen pixels.
    public static void Dock(long id, long owner, int x, int y, int width, int height, bool activate)
    {
        PerMonitor();
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        if (!homes.ContainsKey(id))
        {
            bool maximized = IsZoomed(h);
            if (IsIconic(h) || maximized) ShowWindow(h, 9);
            RECT r;
            GetWindowRect(h, out r);
            homes[id] = new Home { Rect = r, Maximized = maximized };
            SetWindowLongPtr(h, -8, new IntPtr(owner));
        }
        // SWP_NOZORDER | SWP_SHOWWINDOW | SWP_NOOWNERZORDER, and SWP_NOACTIVATE unless asked.
        uint flags = 0x0004 | 0x0040 | 0x0200 | (activate ? 0u : 0x0010u);
        PlaceVisible(h, x, y, Math.Max(120, width), Math.Max(80, height), flags);
        if (activate)
        {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            if (!SetForegroundWindow(h)) SwitchToThisWindow(h, true);
        }
    }

    public static void Undock(long id)
    {
        PerMonitor();
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) { homes.Remove(id); return; }
        SetWindowLongPtr(h, -8, IntPtr.Zero);
        Home home;
        if (!homes.TryGetValue(id, out home)) return;
        homes.Remove(id);
        // SWP_NOZORDER | SWP_NOACTIVATE.
        SetWindowPos(h, IntPtr.Zero, home.Rect.Left, home.Rect.Top, home.Rect.Right - home.Rect.Left, home.Rect.Bottom - home.Rect.Top, 0x0004 | 0x0010);
        if (home.Maximized) ShowWindow(h, 3);
    }

    // Gives a window (not in use on the board) the size of its frame, so its
    // picture shows sharp, pixel for pixel. Where it is stays as it was.
    public static void Size(long id, int width, int height)
    {
        PerMonitor();
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h) || homes.ContainsKey(id)) return;
        if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, 9);
        RECT outer;
        GetWindowRect(h, out outer);
        // SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER.
        PlaceVisible(h, outer.Left, outer.Top, Math.Max(120, width), Math.Max(80, height), 0x0004 | 0x0010 | 0x0200);
    }

    // Asks a window to close, as its X button does; the app may ask to save first.
    public static void Close(long id)
    {
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
`;

// The C# arrives as the first line on stdin (base64): a command line is
// limited to 32767 characters, which the source outgrew.
const script = `
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  [Console]::Out.WriteLine([TerraShell]::Handle($line))
}
`;

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const unb64 = (text) => Buffer.from(text || '', 'base64').toString('utf8');

function createShellHelper({
  platform = process.platform,
  idleMs = 120000,
  timeoutMs = 20000,
  spawnProcess = spawn,
} = {}) {
  let child = null,
    ready = null,
    broken = platform !== 'win32',
    nextId = 1,
    busy = null,
    idleTimer = null,
    buffer = '',
    held = false;
  const queue = [];
  const stop = () => {
    clearTimeout(idleTimer);
    const c = child;
    child = null;
    ready = null;
    if (c && !c.killed) c.kill();
  };
  const fail = (error) => {
    const pending = [...queue.splice(0), ...(busy ? [busy] : [])];
    busy = null;
    for (const request of pending) request.reject(error);
  };
  const start = () => {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const c = spawnProcess(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      child = c;
      buffer = '';
      c.stdin.on('error', () => {});
      c.stdin.write(Buffer.from(csharp, 'utf8').toString('base64') + '\n');
      let started = false;
      const startTimer = setTimeout(() => {
        if (!started) {
          broken = true;
          reject(Error('The Windows icon helper did not start'));
          stop();
        }
      }, 15000);
      c.stdout.setEncoding('ascii');
      c.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!started) {
            if (line === 'ready') {
              started = true;
              clearTimeout(startTimer);
              resolve();
            }
            continue;
          }
          const [id, status, payload] = line.split('\t');
          if (!busy || String(busy.id) !== id) continue;
          const request = busy;
          busy = null;
          clearTimeout(request.timer);
          if (status === 'ok') request.resolve(payload || '');
          else request.reject(Error(unb64(payload) || 'Windows could not do that'));
          pump();
          // A docked app window needs this process to put it back: no idle stop then.
          if (!busy && !queue.length && !held) idleTimer = setTimeout(stop, idleMs);
        }
      });
      c.stderr.on('data', () => {});
      c.on('error', (error) => {
        broken = true;
        clearTimeout(startTimer);
        reject(error);
        fail(error);
      });
      c.on('exit', () => {
        clearTimeout(startTimer);
        if (child === c) {
          child = null;
          ready = null;
        }
        if (!started) {
          broken = true;
          reject(Error('The Windows icon helper stopped'));
        }
        fail(Error('The Windows icon helper stopped'));
      });
    });
    return ready;
  };
  const pump = () => {
    if (busy || !queue.length || !child) return;
    clearTimeout(idleTimer);
    const index = queue.findIndex((request) => request.urgent);
    const request = queue.splice(index >= 0 ? index : 0, 1)[0];
    busy = request;
    request.timer = setTimeout(() => {
      // A hung request (an unreachable network drive) restarts the helper.
      if (busy === request) {
        busy = null;
        request.reject(Error('Windows took too long'));
        stop();
        if (queue.length) void start().then(pump, (error) => fail(error));
      }
    }, timeoutMs);
    child.stdin.write(`${request.id}\t${request.line}\n`);
  };
  const request = (line, urgent = false) => {
    if (broken) return Promise.reject(Error('The Windows icon helper is unavailable'));
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, line, urgent, resolve, reject });
      start().then(pump, (error) => fail(error));
    });
  };
  return {
    get available() {
      return !broken;
    },
    // A PNG (base64) of the item as Explorer shows it, at most size pixels.
    async icon(file, size) {
      return request(`icon\t${b64(file)}\t${size | 0}\t0`);
    },
    // Windows attributes by name for every entry of a folder.
    async attributes(dir) {
      const text = unb64(await request(`attributes\t${b64(dir)}`, true));
      const result = new Map();
      if (!text) return result;
      for (const entry of text.split('|')) {
        const split = entry.lastIndexOf(':');
        if (split > 0) result.set(entry.slice(0, split), parseInt(entry.slice(split + 1), 16) || 0);
      }
      return result;
    },
    async setClipboard(paths, cut) {
      await request(`clip-set\t${b64(paths.join('|'))}\t${cut ? 1 : 0}`, true);
    },
    // Virtual desktops in order, the current one, and the windows open on each.
    async desktops() {
      return JSON.parse(unb64(await request('desktops', true)));
    },
    async focusWindow(id, steps) {
      await request(`focus\t${id}\t${steps | 0}`, true);
    },
    async switchDesktop(steps) {
      await request(`switch\t${steps | 0}`, true);
    },
    async closeWindow(id) {
      await request(`close\t${id}`, true);
    },
    async dockWindow(id, owner, { x, y, width, height }, activate) {
      await request(
        `dock\t${id}\t${owner}\t${x | 0}\t${y | 0}\t${width | 0}\t${height | 0}\t${activate ? 1 : 0}`,
        true,
      );
    },
    async sizeWindow(id, width, height) {
      await request(`size\t${id}\t${width | 0}\t${height | 0}`, true);
    },
    async undockWindow(id) {
      await request(`undock\t${id}`, true);
    },
    // Keeps the process running (windows are docked) or lets it stop when idle.
    hold(on) {
      held = !!on;
      if (held) clearTimeout(idleTimer);
    },
    async readClipboard() {
      const text = unb64(await request('clip-get', true));
      if (!text) return null;
      const [cut, ...paths] = text.split('|');
      return { cut: cut === '1', paths: paths.filter(Boolean) };
    },
    stop,
  };
}

module.exports = { createShellHelper };
