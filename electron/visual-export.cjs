const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createVisualExport({ dialog, shell, getWindow }) {
  const saved = new Map();
  return {
    async save({ format, name, bytes }) {
      if (!['png', 'jpg', 'pdf'].includes(format)) throw Error('Unsupported export format.');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024 * 1024)
        throw Error('Invalid export data.');
      const data = Buffer.from(bytes);
      const valid =
        format === 'png'
          ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : format === 'jpg'
            ? data[0] === 255 && data[1] === 216
            : data.subarray(0, 5).toString() === '%PDF-';
      if (!valid) throw Error('Export data does not match the selected format.');
      const basename =
        String(name || 'Board')
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
          .slice(0, 150)
          .replace(/[. ]+$/, '') || 'Board';
      const result = await dialog.showSaveDialog(getWindow(), {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: `${basename}.${format}`,
        filters: [
          {
            name: format === 'pdf' ? 'PDF document' : `${format.toUpperCase()} image`,
            extensions: [format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return null;
      const file = result.filePath;
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, data, { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      const id = randomUUID();
      saved.set(id, file);
      if (saved.size > 100) saved.delete(saved.keys().next().value);
      return { id, name: path.basename(file) };
    },
    async open(id, folder) {
      const file = saved.get(id);
      if (!file) throw Error('This export is no longer available.');
      await fs.access(file);
      if (folder) shell.showItemInFolder(file);
      else {
        const error = await shell.openPath(file);
        if (error) throw Error(error);
      }
    },
  };
}
module.exports = { createVisualExport };
