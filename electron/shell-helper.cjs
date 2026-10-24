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
`;

const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${csharp}
'@ -ReferencedAssemblies System.Drawing,System.Windows.Forms
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
    buffer = '';
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
          if (!busy && !queue.length) idleTimer = setTimeout(stop, idleMs);
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
