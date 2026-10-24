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
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth, biHeight;
        public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage;
        public int biXPelsPerMeter, biYPelsPerMeter;
        public uint biClrUsed, biClrImportant;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, out BITMAP bm);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER info, uint usage);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
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
                case "dock": return id + "\tok\t" + Out(TerraDesktops.Dock(long.Parse(parts[2]), long.Parse(parts[3]), int.Parse(parts[4]), int.Parse(parts[5]), int.Parse(parts[6]), int.Parse(parts[7]), parts[8] == "1", parts[9] == "1", int.Parse(parts[10]), int.Parse(parts[11])));
                case "park": return id + "\tok\t" + Out(TerraDesktops.Park(long.Parse(parts[2]), long.Parse(parts[3]), int.Parse(parts[4]), int.Parse(parts[5]), int.Parse(parts[6]), int.Parse(parts[7])));
                case "release": TerraDesktops.Release(long.Parse(parts[2]), parts.Length > 3 ? Arg(parts[3]) : ""); return id + "\tok\t";
                case "hide": TerraDesktops.Hide(long.Parse(parts[2])); return id + "\tok\t";
                case "mouse": TerraInput.Mouse(long.Parse(parts[2]), parts[3], int.Parse(parts[4]), int.Parse(parts[5]), int.Parse(parts[6]), int.Parse(parts[7]), int.Parse(parts[8])); return id + "\tok\t";
                case "key": TerraInput.Key(long.Parse(parts[2]), int.Parse(parts[3]), int.Parse(parts[4]), parts[5] == "1", parts[6] == "1", int.Parse(parts[7])); return id + "\tok\t";
                case "text": TerraInput.Text(long.Parse(parts[2]), Arg(parts[3])); return id + "\tok\t";
                case "appfocus": TerraInput.Focus(long.Parse(parts[2]), parts[3] == "1"); return id + "\tok\t";
                case "popup": return id + "\tok\t" + (TerraInput.HasPopup(long.Parse(parts[2])) ? "1" : "0");
                case "drives": return id + "\tok\t" + Out(Drives());
                case "ping": return id + "\tok\t";
            }
            return id + "\terr\t" + Out("Unknown operation");
        }
        catch (Exception e)
        {
            return id + "\terr\t" + Out(e.Message);
        }
    }

    // The drives for This PC, one per line: root, name, total bytes, free bytes.
    // Network drives are not asked whether they are ready (a disconnected one
    // can take many seconds to answer).
    static string Drives()
    {
        var sb = new StringBuilder();
        foreach (var d in System.IO.DriveInfo.GetDrives())
        {
            string letter = d.Name.TrimEnd('\\'), label = "";
            long total = 0, free = 0;
            bool network = d.DriveType == System.IO.DriveType.Network;
            try
            {
                if (!network && d.IsReady)
                {
                    label = d.VolumeLabel;
                    total = d.TotalSize;
                    free = d.AvailableFreeSpace;
                }
            }
            catch { }
            if (string.IsNullOrEmpty(label))
                label = d.DriveType == System.IO.DriveType.Removable ? "USB Drive"
                    : d.DriveType == System.IO.DriveType.CDRom ? "DVD Drive"
                    : network ? "Network Drive" : "Local Disk";
            sb.Append(d.Name).Append('\t').Append(label.Replace('\t', ' ').Replace('\n', ' ')).Append(" (").Append(letter).Append(")\t")
              .Append(total).Append('\t').Append(free).Append('\n');
        }
        return sb.ToString();
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
            if (GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), out bm) == 0) throw new Exception("Unexpected bitmap");
            int w = bm.bmWidth, h = Math.Abs(bm.bmHeight), stride = w * 4;
            // GDI copies the rows top-down. Reading bmBits directly cannot tell
            // which way up they are: thumbnails and icons both claim bottom-up,
            // but photo thumbnails are stored the other way round.
            var info = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
            byte[] px = new byte[stride * h];
            IntPtr dc = GetDC(IntPtr.Zero);
            int lines;
            try { lines = GetDIBits(dc, hbm, 0, (uint)h, px, ref info, 0); }
            finally { ReleaseDC(IntPtr.Zero, dc); }
            if (lines != h) throw new Exception("Unexpected bitmap");
            // Thumbnails of photos come without alpha (all zero): they are opaque.
            bool alpha = false;
            for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) { alpha = true; break; }
            using (var bmp = new Bitmap(w, h, alpha ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppRgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, bmp.PixelFormat);
                for (int y = 0; y < h; y++) Marshal.Copy(px, y * stride, data.Scan0 + y * data.Stride, stride);
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
                { "border", InvisibleBorder(h) },
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

    // The invisible resize border around a window (left, top, right, bottom),
    // which a captured picture of it includes.
    static int[] InvisibleBorder(IntPtr h)
    {
        RECT outer, visible;
        if (!GetWindowRect(h, out outer) || DwmGetWindowAttribute(h, 9, out visible, Marshal.SizeOf(typeof(RECT))) != 0)
            return new int[] { 0, 0, 0, 0 };
        return new int[] {
            Math.Max(0, visible.Left - outer.Left), Math.Max(0, visible.Top - outer.Top),
            Math.Max(0, outer.Right - visible.Right), Math.Max(0, outer.Bottom - visible.Bottom) };
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

    // App frames. While nobody uses it, a window on the board is "parked":
    // restored (never minimized, so Windows keeps capturing it) and placed just
    // behind Terra's window, where it cannot be seen. Using it lays it over its
    // frame, owned by Terra's window so it stays above it. Released, it goes
    // back exactly as it was before it joined the board.
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPosition, maxPosition; public RECT normalPosition; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
    static readonly System.Collections.Generic.Dictionary<long, WINDOWPLACEMENT> homes = new System.Collections.Generic.Dictionary<long, WINDOWPLACEMENT>();
    const uint NOZORDER = 0x0004, NOACTIVATE = 0x0010, SHOWWINDOW = 0x0040, NOOWNERZORDER = 0x0200;

    // Real pixels on every screen, whatever this process was started as.
    static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

    static WINDOWPLACEMENT Placement(IntPtr h)
    {
        var wp = new WINDOWPLACEMENT();
        wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        GetWindowPlacement(h, ref wp);
        return wp;
    }

    static IntPtr Prepare(long id, long terra)
    {
        PerMonitor();
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        if (id == terra) throw new Exception("Terra Board can't hold its own window.");
        if (!homes.ContainsKey(id)) homes[id] = Placement(h);
        // Minimized or maximized: back to a normal window, without coming forward.
        if (IsIconic(h) || IsZoomed(h))
        {
            var wp = Placement(h);
            wp.flags = 0;
            wp.showCmd = 4;
            SetWindowPlacement(h, ref wp);
        }
        return h;
    }

    // Places a window so what you see of it (without the invisible resize
    // borders Windows adds around most windows) fills the rectangle exactly.
    static void PlaceVisible(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags)
    {
        if (after == IntPtr.Zero) flags |= NOZORDER;
        SetWindowPos(h, after, x, y, width, height, flags);
        RECT outer, visible;
        if (!GetWindowRect(h, out outer) || DwmGetWindowAttribute(h, 9, out visible, Marshal.SizeOf(typeof(RECT))) != 0) return;
        int left = visible.Left - outer.Left, top = visible.Top - outer.Top;
        int right = outer.Right - visible.Right, bottom = outer.Bottom - visible.Bottom;
        if (left == 0 && top == 0 && right == 0 && bottom == 0 && outer.Left == x && outer.Top == y) return;
        SetWindowPos(h, after, x - left, y - top, width + left + right, height + top + bottom, flags | NOACTIVATE);
    }

    // Parked: just behind Terra's window, at this place and size (physical
    // pixels). On a screen, so it keeps drawing itself for its picture.
    public static string Park(long id, long terra, int x, int y, int width, int height)
    {
        IntPtr h = Prepare(id, terra);
        SetWindowLongPtr(h, -8, IntPtr.Zero);
        PlaceVisible(h, new IntPtr(terra), x, y, Math.Max(120, width), Math.Max(80, height), NOACTIVATE | NOOWNERZORDER);
        return Saved(id);
    }

    // Where and how a window was before it joined the board, as text Terra
    // keeps (so a restarted helper can still put it back).
    static string Saved(long id)
    {
        WINDOWPLACEMENT wp;
        if (!homes.TryGetValue(id, out wp)) return "";
        return string.Join(",", new int[] { wp.flags, wp.showCmd, wp.minPosition.X, wp.minPosition.Y, wp.maxPosition.X, wp.maxPosition.Y,
            wp.normalPosition.Left, wp.normalPosition.Top, wp.normalPosition.Right, wp.normalPosition.Bottom });
    }

    // Terra's helper is ending (Terra closed or crashed): every window on a
    // board goes back where and as it was.
    public static void ReleaseAll()
    {
        foreach (var id in new System.Collections.Generic.List<long>(homes.Keys)) Release(id);
    }

    // In use: over its frame and above Terra, optionally passing on the click
    // that started it (the window is now exactly where its picture was).
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    public static string Dock(long id, long terra, int x, int y, int width, int height, bool activate, bool click, int clickX, int clickY)
    {
        IntPtr h = Prepare(id, terra);
        SetWindowLongPtr(h, -8, new IntPtr(terra));
        PlaceVisible(h, IntPtr.Zero, x, y, Math.Max(120, width), Math.Max(80, height), SHOWWINDOW | NOOWNERZORDER | (activate ? 0u : NOACTIVATE));
        if (!activate) return Saved(id);
        // Windows lets the process that just pressed a key bring a window forward.
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        if (!SetForegroundWindow(h)) SwitchToThisWindow(h, true);
        // Only a real click there: the cursor must be where the click was.
        POINT cursor;
        if (click && GetCursorPos(out cursor) && Math.Abs(cursor.X - clickX) <= 4 && Math.Abs(cursor.Y - clickY) <= 4)
        {
            System.Threading.Thread.Sleep(40);
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        }
        return Saved(id);
    }

    // Back where and as it was before it joined the board.
    public static void Release(long id) { Release(id, ""); }
    public static void Release(long id, string saved)
    {
        PerMonitor();
        IntPtr h = new IntPtr(id);
        WINDOWPLACEMENT home;
        bool known = homes.TryGetValue(id, out home);
        if (!known && saved.Length > 0)
        {
            // Kept by Terra from an earlier run of this helper.
            var v = Array.ConvertAll(saved.Split(','), int.Parse);
            if (v.Length == 10)
            {
                home = new WINDOWPLACEMENT();
                home.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                home.flags = v[0];
                home.showCmd = v[1];
                home.minPosition = new POINT { X = v[2], Y = v[3] };
                home.maxPosition = new POINT { X = v[4], Y = v[5] };
                home.normalPosition = new RECT { Left = v[6], Top = v[7], Right = v[8], Bottom = v[9] };
                known = true;
            }
        }
        homes.Remove(id);
        if (!IsWindow(h)) return;
        SetWindowLongPtr(h, -8, IntPtr.Zero);
        if (!known) return;
        // Minimized stays minimized, maximized maximized, otherwise shown without coming forward.
        home.showCmd = home.showCmd == 2 ? 7 : home.showCmd == 3 ? 3 : 4;
        SetWindowPlacement(h, ref home);
    }

    // Terra minimized: its app windows go with it.
    public static void Hide(long id)
    {
        IntPtr h = new IntPtr(id);
        if (IsWindow(h) && !IsIconic(h)) ShowWindow(h, 7);
    }

    // Asks a window to close, as its X button does; the app may ask to save first.
    public static void Close(long id)
    {
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
// App frames used in place: Terra is the app's screen, mouse and keyboard.
// The real window stays hidden behind Terra; the frame's mouse and keyboard
// input is posted to it as the Windows messages real input would bring, and it
// is told it has the focus. Nothing comes to the front.
public static class TerraInput
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

    const uint WM_MOUSEMOVE = 0x0200, WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020E, WM_MOUSELEAVE = 0x02A3;
    static readonly uint[] Down = { 0x0201, 0x0207, 0x0204 };
    static readonly uint[] Up = { 0x0202, 0x0208, 0x0205 };
    static readonly uint[] Double = { 0x0203, 0x0209, 0x0206 };

    // The window that took a press keeps the drag until the release, as mouse capture would.
    static IntPtr pressed = IntPtr.Zero;
    static IntPtr hovered = IntPtr.Zero;

    static IntPtr Pack(int low, int high) { return new IntPtr((int)((ushort)low | ((uint)(ushort)high << 16))); }

    static IntPtr Window(long id)
    {
        IntPtr h = new IntPtr(id);
        if (!IsWindow(h)) throw new Exception("That window has closed.");
        return h;
    }

    // Mouse input at a spot of the window's picture: x and y in ten-thousandths
    // of what shows of the window (without its invisible border).
    public static void Mouse(long id, string kind, int x, int y, int button, int keys, int delta)
    {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr top = Window(id);
        RECT v;
        if (DwmGetWindowAttribute(top, 9, out v, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(top, out v);
        int sx = v.Left + (int)Math.Round((v.Right - v.Left) * x / 10000.0);
        int sy = v.Top + (int)Math.Round((v.Bottom - v.Top) * y / 10000.0);
        if (kind == "leave")
        {
            if (hovered != IntPtr.Zero) PostMessage(hovered, WM_MOUSELEAVE, IntPtr.Zero, IntPtr.Zero);
            hovered = IntPtr.Zero;
            return;
        }
        if (kind == "wheel" || kind == "hwheel")
        {
            // Wheel messages carry the screen position; they go to the window under it.
            IntPtr wheelTarget = Deepest(top, sx, sy);
            PostMessage(wheelTarget, kind == "wheel" ? WM_MOUSEWHEEL : WM_MOUSEHWHEEL, Pack(keys, delta), Pack(sx, sy));
            return;
        }
        IntPtr target = (kind == "move" || kind == "up") && pressed != IntPtr.Zero && IsWindow(pressed) ? pressed : Deepest(top, sx, sy);
        POINT c = new POINT { X = sx, Y = sy };
        ScreenToClient(target, ref c);
        IntPtr at = Pack(c.X, c.Y);
        if (hovered != target && hovered != IntPtr.Zero && pressed == IntPtr.Zero)
            PostMessage(hovered, WM_MOUSELEAVE, IntPtr.Zero, IntPtr.Zero);
        hovered = target;
        int b = Math.Max(0, Math.Min(2, button));
        switch (kind)
        {
            case "move":
                PostMessage(target, WM_MOUSEMOVE, new IntPtr(keys), at);
                break;
            case "down":
            case "double":
                pressed = target;
                PostMessage(target, WM_MOUSEMOVE, new IntPtr(keys), at);
                PostMessage(target, kind == "double" ? Double[b] : Down[b], new IntPtr(keys), at);
                break;
            case "up":
                PostMessage(target, Up[b], new IntPtr(keys), at);
                pressed = IntPtr.Zero;
                break;
        }
    }

    // The innermost visible child window at a screen point (classic apps put
    // their controls in child windows; most modern ones draw everything in one).
    static IntPtr Deepest(IntPtr top, int sx, int sy)
    {
        IntPtr target = top;
        for (int depth = 0; depth < 32; depth++)
        {
            POINT p = new POINT { X = sx, Y = sy };
            ScreenToClient(target, ref p);
            // CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT
            IntPtr child = ChildWindowFromPointEx(target, p, 0x0001 | 0x0002 | 0x0004);
            if (child == IntPtr.Zero || child == target) break;
            target = child;
        }
        return target;
    }

    // Where keys go in that app: its focused control, or the window itself.
    static IntPtr Focused(IntPtr top, out uint thread)
    {
        uint pid;
        thread = GetWindowThreadProcessId(top, out pid);
        var info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero) return info.hwndFocus;
        return top;
    }

    // A key pressed or released (virtual-key code, scan code). mods: 1 Shift,
    // 2 Ctrl, 4 Alt. With modifiers the app's thread briefly sees them held,
    // as it reads them from its own keyboard state rather than the message.
    public static void Key(long id, int vk, int scan, bool extended, bool down, int mods)
    {
        IntPtr top = Window(id);
        uint thread;
        IntPtr target = Focused(top, out thread);
        if (scan == 0) scan = (int)MapVirtualKey((uint)vk, 0);
        bool alt = (mods & 4) != 0;
        uint lp = 1u | ((uint)(scan & 0xFF) << 16) | (extended ? 1u << 24 : 0) | (alt ? 1u << 29 : 0) | (down ? 0 : (1u << 30) | (1u << 31));
        uint msg = alt ? (down ? 0x0104u : 0x0105u) : (down ? 0x0100u : 0x0101u);
        if (mods == 0)
        {
            PostMessage(target, msg, new IntPtr(vk), new IntPtr((int)lp));
            return;
        }
        uint self = GetCurrentThreadId();
        bool attached = AttachThreadInput(self, thread, true);
        byte[] state = new byte[256], saved = new byte[256];
        GetKeyboardState(saved);
        Array.Copy(saved, state, 256);
        if ((mods & 1) != 0) { state[0x10] = 0x80; state[0xA0] = 0x80; }
        if ((mods & 2) != 0) { state[0x11] = 0x80; state[0xA2] = 0x80; }
        if (alt) { state[0x12] = 0x80; state[0xA4] = 0x80; }
        SetKeyboardState(state);
        PostMessage(target, msg, new IntPtr(vk), new IntPtr((int)lp));
        System.Threading.Thread.Sleep(30);
        SetKeyboardState(saved);
        if (attached) AttachThreadInput(self, thread, false);
    }

    // Typed text: one character message per UTF-16 unit, as the keyboard and
    // input methods deliver it.
    public static void Text(long id, string text)
    {
        IntPtr top = Window(id);
        uint thread;
        IntPtr target = Focused(top, out thread);
        foreach (char ch in text) PostMessage(target, 0x0102, new IntPtr(ch), new IntPtr(1));
    }

    // Tells the app its window is (or no longer is) the active one, so it
    // shows its caret and takes keys, while Terra stays in front.
    public static void Focus(long id, bool on)
    {
        IntPtr top = Window(id);
        if (on)
        {
            PostMessage(top, 0x001C, new IntPtr(1), IntPtr.Zero); // WM_ACTIVATEAPP
            PostMessage(top, 0x0086, new IntPtr(1), IntPtr.Zero); // WM_NCACTIVATE
            PostMessage(top, 0x0006, new IntPtr(1), IntPtr.Zero); // WM_ACTIVATE (WA_ACTIVE)
            PostMessage(top, 0x0007, IntPtr.Zero, IntPtr.Zero); // WM_SETFOCUS
        }
        else
        {
            PostMessage(top, 0x0008, IntPtr.Zero, IntPtr.Zero); // WM_KILLFOCUS
            PostMessage(top, 0x0006, IntPtr.Zero, IntPtr.Zero); // WM_ACTIVATE (WA_INACTIVE)
            PostMessage(top, 0x0086, IntPtr.Zero, IntPtr.Zero); // WM_NCACTIVATE
            PostMessage(top, 0x001C, IntPtr.Zero, IntPtr.Zero); // WM_ACTIVATEAPP
        }
    }

    // Whether the app shows a popup (a menu or list) of its own right now:
    // a visible top-level window of its process other than the window itself.
    public static bool HasPopup(long id)
    {
        IntPtr top = Window(id);
        uint pid;
        GetWindowThreadProcessId(top, out pid);
        bool found = false;
        EnumWindows((h, l) =>
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            // WS_POPUP windows of the same process, other than the app's own window.
            if (p == pid && h != top && IsWindowVisible(h) && (GetWindowLong(h, -16) & unchecked((int)0x80000000)) != 0)
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
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
  if ($null -eq $line) { [TerraDesktops]::ReleaseAll(); break }
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
  // Its input ends first, so it puts back any app window still on a board
  // before it exits (it does the same if Terra itself goes away).
  const stop = () => {
    clearTimeout(idleTimer);
    const c = child;
    child = null;
    ready = null;
    if (!c || c.killed) return;
    try {
      c.stdin.end();
    } catch {}
    setTimeout(() => {
      if (c.exitCode === null && !c.killed) c.kill();
    }, 3000).unref?.();
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
  const request = (line, urgent = false, coalesce = null) => {
    if (broken) return Promise.reject(Error('The Windows icon helper is unavailable'));
    return new Promise((resolve, reject) => {
      if (coalesce) {
        const waiting = queue.find((r) => r.coalesce === coalesce);
        if (waiting) {
          waiting.line = line;
          waiting.resolvers.push(resolve);
          return;
        }
      }
      const entry = { id: nextId++, line, urgent, coalesce, resolvers: [], resolve: null, reject };
      entry.resolve = (value) => {
        resolve(value);
        for (const other of entry.resolvers) other(value);
      };
      queue.push(entry);
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
    async drives() {
      return unb64(await request('drives', true))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [root, name, total, free] = line.split('\t');
          return { path: root, name, total: Number(total) || 0, free: Number(free) || 0 };
        });
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
    // click: a point (physical pixels) where a real click started using it.
    async dockWindow(id, owner, { x, y, width, height }, activate, click) {
      const saved = await request(
        `dock\t${id}\t${owner}\t${x | 0}\t${y | 0}\t${width | 0}\t${height | 0}\t${activate ? 1 : 0}\t${click ? 1 : 0}\t${click ? click.x | 0 : 0}\t${click ? click.y | 0 : 0}`,
        true,
      );
      return unb64(saved);
    },
    // Each answers with the window's saved place (see release).
    async parkWindow(id, owner, { x, y, width, height }) {
      return unb64(
        await request(
          `park\t${id}\t${owner}\t${x | 0}\t${y | 0}\t${width | 0}\t${height | 0}`,
          true,
        ),
      );
    },
    // saved: the place parkWindow or dockWindow reported, for a helper that
    // has since restarted.
    async releaseWindow(id, saved = '') {
      await request(`release\t${id}\t${b64(saved)}`, true);
    },
    async hideWindow(id) {
      await request(`hide\t${id}`, true);
    },
    // App frames used in place: input posted to the hidden window. Mouse moves
    // replace a move still waiting, so a busy app never lags behind the pointer.
    appInput(id, event) {
      let line;
      if (event.type === 'mouse')
        line = `mouse\t${id}\t${event.kind}\t${event.x | 0}\t${event.y | 0}\t${event.button | 0}\t${event.keys | 0}\t${event.delta | 0}`;
      else if (event.type === 'key')
        line = `key\t${id}\t${event.vk | 0}\t${event.scan | 0}\t${event.extended ? 1 : 0}\t${event.down ? 1 : 0}\t${event.mods | 0}`;
      else if (event.type === 'text') line = `text\t${id}\t${b64(event.text)}`;
      else if (event.type === 'focus') line = `appfocus\t${id}\t${event.on ? 1 : 0}`;
      else return Promise.resolve();
      const coalesce = event.type === 'mouse' && event.kind === 'move' ? `move:${id}` : null;
      return request(line, true, coalesce).catch(() => {});
    },
    async hasPopup(id) {
      return (await request(`popup\t${id}`, true)) === '1';
    },
    // Keeps the process running (app windows are on the board: it must put
    // them back) or lets it stop when idle.
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
