// Independent clipboard consumer for desktop-copy verification. Restores the
// user's clipboard on exit; the application under test never gets this API.
const { app, clipboard, ClipboardItem, BrowserWindow } = require('electron');
const { createInterface } = require('node:readline');
const { createServer } = require('node:net');
const { createHash } = require('node:crypto');
const path = require('node:path');
const sharp = require('sharp');
const { fileURLToPath } = require('node:url');
app.setPath('userData', path.resolve(process.argv[2], 'probe-settings'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
let connection;
const reply = (id, data) =>
  (connection || process.stdout).write(JSON.stringify({ id, ...data }) + '\n');
app
  .whenReady()
  .then(async () => {
    const saved = [];
    for (const item of await clipboard.read()) {
      const data = {};
      for (const type of item.types) data[type] = await item.getType(type);
      saved.push(new ClipboardItem(data));
    }
    let receiver;
    const inspectImage = async (bytes) => {
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, hash: hash(data) };
    };
    let chain = Promise.resolve();
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    reply(0, { result: server.address().port });
    connection = await new Promise((resolve) => server.once('connection', resolve));
    const lines = createInterface({ input: connection });
    lines.on('line', (line) => {
      chain = chain.then(async () => {
        const { id, command } = JSON.parse(line);
        try {
          if (command === 'read') {
            const items = await clipboard.read();
            const result = { types: items.flatMap((i) => i.types) };
            for (const item of items) {
              if (item.types.includes('text/uri-list')) {
                const url = (await (await item.getType('text/uri-list')).text()).split(/\r?\n/)[0];
                result.fileImage = await inspectImage(fileURLToPath(url));
              }
              if (item.types.includes('image/png')) {
                const blob = await item.getType('image/png');
                result.image = await inspectImage(Buffer.from(await blob.arrayBuffer()));
              }
              if (item.types.includes('text/plain'))
                result.text = await (await item.getType('text/plain')).text();
              if (item.types.includes('web application/x-terra-board-objects'))
                result.objects = JSON.parse(
                  await (await item.getType('web application/x-terra-board-objects')).text(),
                );
            }
            reply(id, { result });
          } else if (command === 'paste') {
            if (!receiver) {
              receiver = new BrowserWindow({
                show: false,
                webPreferences: { sandbox: true, contextIsolation: true },
              });
              await receiver.loadURL(
                'data:text/html,' +
                  encodeURIComponent(`<textarea autofocus></textarea><script>
              window.addEventListener('paste', async e => {
                e.preventDefault();
                const file = [...e.clipboardData.files].find(f => f.type.startsWith('image/'));
                window.pasted = file ? [...new Uint8Array(await file.arrayBuffer())] : [];
              });</script>`),
              );
            }
            await receiver.webContents.executeJavaScript(
              'window.pasted=null;document.querySelector("textarea").focus()',
            );
            receiver.webContents.paste();
            let bytes;
            for (let n = 0; n < 100; n++) {
              bytes = await receiver.webContents.executeJavaScript('window.pasted');
              if (bytes) break;
              await new Promise((r) => setTimeout(r, 30));
            }
            if (!bytes?.length) throw Error('Other application did not receive an image paste');
            reply(id, { result: await inspectImage(Buffer.from(bytes)) });
          } else if (command === 'image-only') {
            const item = (await clipboard.read()).find((item) => item.types.includes('image/png'));
            if (!item) throw Error('Copy an image before requesting image-only clipboard');
            await clipboard.write([
              new ClipboardItem({ 'image/png': await item.getType('image/png') }),
            ]);
            reply(id, { result: true });
          } else if (command === 'clear') {
            await clipboard.clear();
            reply(id, { result: true });
          } else throw Error('Unknown probe command');
        } catch (e) {
          reply(id, { error: e.message });
        }
      });
    });
    lines.on('close', () => {
      void chain.finally(async () => {
        if (saved.length) await clipboard.write(saved);
        else await clipboard.clear();
        receiver?.destroy();
        server.close();
        app.quit();
      });
    });
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
