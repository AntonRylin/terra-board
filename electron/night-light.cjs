'use strict';

// Windows' Night light (low blue light). Windows keeps its on/off state in a
// CloudStore blob and applies a change as soon as the blob is rewritten with
// a newer timestamp. Layout (stable since Windows 10 1709):
//   bytes 10..14  last-change time, Unix seconds as a 5-byte varint
//   byte  18      0x13 off, 0x15 on
//   bytes 23..24  0x10 0x00, present only while on
const { execFile } = require('node:child_process');

const key =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\' +
  'default$windows.data.bluelightreduction.bluelightreductionstate\\' +
  'windows.data.bluelightreduction.bluelightreductionstate';

const OFF = 0x13,
  ON = 0x15;

function known(data) {
  return (
    data.length >= 25 &&
    data[0] === 0x43 &&
    data[1] === 0x42 &&
    (data[18] === OFF || data[18] === ON) &&
    // The 5-byte timestamp: four bytes with the "more" bit, then the last.
    [10, 11, 12, 13].every((i) => data[i] & 0x80) &&
    !(data[14] & 0x80)
  );
}

function isOn(data) {
  return data[18] === ON && data[23] === 0x10 && data[24] === 0x00;
}

function readTime(data) {
  let value = 0;
  for (let i = 4; i >= 0; i--) value = value * 128 + (data[10 + i] & 0x7f);
  return value;
}

// The blob with Night light on or off and a newer timestamp, or null when the
// layout isn't one this code knows (then nothing is written).
function withState(data, on, now = Math.floor(Date.now() / 1000)) {
  const bytes = Buffer.from(data);
  if (!known(bytes)) return null;
  let next;
  if (on === isOn(bytes)) next = Buffer.from(bytes);
  else if (on)
    next = Buffer.concat([bytes.subarray(0, 23), Buffer.from([0x10, 0x00]), bytes.subarray(23)]);
  else next = Buffer.concat([bytes.subarray(0, 23), bytes.subarray(25)]);
  next[18] = on ? ON : OFF;
  let time = Math.max(now, readTime(bytes) + 1);
  for (let i = 0; i < 5; i++) {
    next[10 + i] = (time % 128) | (i < 4 ? 0x80 : 0);
    time = Math.floor(time / 128);
  }
  return next;
}

const reg = (args) =>
  new Promise((resolve, reject) =>
    execFile('reg.exe', args, { windowsHide: true, timeout: 10000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );

async function read() {
  const out = await reg(['query', key, '/v', 'Data']);
  const match = /\bData\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(out);
  if (!match) throw Error('Night light state not found');
  return Buffer.from(match[1], 'hex');
}

function createNightLight({ platform = process.platform } = {}) {
  const windows = platform === 'win32';
  async function state() {
    if (!windows) return { supported: false };
    try {
      const data = await read();
      return known(data) ? { supported: true, on: isOn(data) } : { supported: false };
    } catch {
      // Windows makes the value the first time Night light is opened in Settings.
      return { supported: false };
    }
  }
  async function set({ on } = {}) {
    if (!windows) throw Error('Night light is a Windows feature.');
    const next = withState(await read(), !!on);
    if (!next) throw Error('This version of Windows stores Night light differently.');
    await reg(['add', key, '/v', 'Data', '/t', 'REG_BINARY', '/d', next.toString('hex'), '/f']);
    return state();
  }
  return { state, set };
}

module.exports = { createNightLight, withState, isOn, known };
