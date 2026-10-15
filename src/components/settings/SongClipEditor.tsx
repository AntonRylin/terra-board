import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Play, Square } from 'lucide-react';

// The part of a song that plays as an entrance song.
const MIN = 2;
const MAX = 15;
const DEFAULT = 8;
// The detailed view shows this many seconds around the selection.
const SPAN = 60;
// Peaks are kept per 10 ms.
const BIN = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const time = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const cssVar = (el: Element, name: string, fallback: string) =>
  getComputedStyle(el).getPropertyValue(name).trim() || fallback;

function peaksOf(buffer: AudioBuffer) {
  const per = Math.max(1, Math.round(buffer.sampleRate * BIN));
  const count = Math.ceil(buffer.length / per);
  const peaks = new Float32Array(count);
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < count; i++) {
      let max = peaks[i];
      const end = Math.min(data.length, (i + 1) * per);
      for (let j = i * per; j < end; j += 4) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
  }
  let top = 0;
  for (const v of peaks) if (v > top) top = v;
  if (top > 0) for (let i = 0; i < count; i++) peaks[i] /= top;
  return peaks;
}

// Where the song is loudest for `length` seconds: a good first guess at the chorus.
function loudest(peaks: Float32Array, length: number) {
  const window = Math.round(length / BIN);
  if (peaks.length <= window) return 0;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += peaks[i] * peaks[i];
  let best = sum;
  let at = 0;
  for (let i = window; i < peaks.length; i++) {
    sum += peaks[i] * peaks[i] - peaks[i - window] * peaks[i - window];
    if (sum > best) {
      best = sum;
      at = i - window + 1;
    }
  }
  return at * BIN;
}

// 16-bit WAV of one part of the song, with a short fade at both ends.
export function encodeClip(buffer: AudioBuffer, start: number, length: number) {
  const rate = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const from = Math.floor(start * rate);
  const frames = Math.max(0, Math.min(buffer.length - from, Math.floor(length * rate)));
  const out = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, frames * channels * 2, true);
  const fadeIn = Math.min(frames / 2, rate * 0.04);
  const fadeOut = Math.min(frames / 2, rate * 0.4);
  const data = [...Array(channels)].map((_, c) => buffer.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    const gain = Math.min(1, i / fadeIn, (frames - i) / fadeOut);
    for (let c = 0; c < channels; c++) {
      const v = clamp(data[c][from + i] * gain, -1, 1);
      out.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

type Drag = { mode: 'move' | 'left' | 'right'; offset: number; end: number } | null;

// Choose which part of a song plays: drag the highlighted part, or its edges.
export function SongClipEditor({
  bytes,
  name,
  busy,
  onSave,
  onCancel,
}: {
  bytes: ArrayBuffer;
  name: string;
  busy: boolean;
  onSave: (clip: Blob, name: string) => void;
  onCancel: () => void;
}) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState('');
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(DEFAULT);
  const [viewStart, setViewStart] = useState(0);
  const [playing, setPlaying] = useState<{ at: number; startedAt: number } | null>(null);
  const [, tick] = useState(0);
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const detail = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag>(null);

  useEffect(() => {
    const ctx = new AudioContext();
    context.current = ctx;
    ctx
      .decodeAudioData(bytes.slice(0))
      .then(setBuffer)
      .catch(() => setError('This file is not a song Terra Board can play.'));
    return () => {
      source.current?.stop();
      void ctx.close();
    };
  }, [bytes]);

  const duration = buffer?.duration ?? 0;
  const span = Math.min(SPAN, duration);
  const peaks = useMemo(() => (buffer ? peaksOf(buffer) : null), [buffer]);

  // Start on the loudest part.
  useEffect(() => {
    if (!peaks || !duration) return;
    const len = Math.min(DEFAULT, duration);
    const at = clamp(loudest(peaks, len), 0, duration - len);
    setLength(len);
    setStart(at);
    setViewStart(clamp(at + len / 2 - Math.min(SPAN, duration) / 2, 0, duration - span));
  }, [peaks]);

  // Keep the selection inside the detailed view.
  const select = (nextStart: number, nextLength: number) => {
    const len = clamp(nextLength, Math.min(MIN, duration), Math.min(MAX, duration));
    const s = clamp(nextStart, 0, duration - len);
    setStart(s);
    setLength(len);
    setViewStart((v) => (s < v ? s : s + len > v + span ? s + len - span : v));
    stop();
  };

  const draw = (canvas: HTMLCanvasElement | null, from: number, to: number) => {
    if (!canvas || !peaks) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const g = canvas.getContext('2d')!;
    g.scale(ratio, ratio);
    const accent = cssVar(canvas, '--st-accent', '#387aca');
    const muted = cssVar(canvas, '--st-line', '#d5dae2');
    const bar = width > 200 ? 3 : 2;
    for (let x = 0; x < width; x += bar) {
      const t0 = from + (x / width) * (to - from);
      const t1 = from + ((x + bar) / width) * (to - from);
      let max = 0;
      for (let i = Math.floor(t0 / BIN); i < Math.min(peaks.length, Math.ceil(t1 / BIN)); i++)
        if (peaks[i] > max) max = peaks[i];
      const h = Math.max(1.5, max * (height - 4));
      const mid = (t0 + t1) / 2;
      g.fillStyle = mid >= start && mid <= start + length ? accent : muted;
      g.fillRect(x, (height - h) / 2, bar - 1, h);
    }
  };
  useEffect(() => {
    draw(detail.current, viewStart, viewStart + span);
    if (duration > SPAN) draw(overview.current, 0, duration);
  });

  const play = () => {
    const ctx = context.current;
    if (!ctx || !buffer) return;
    stop();
    void ctx.resume();
    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    node.buffer = buffer;
    node.connect(gain).connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.8, now + 0.04);
    gain.gain.setValueAtTime(0.8, now + Math.max(0.05, length - 0.4));
    gain.gain.linearRampToValueAtTime(0.0001, now + length);
    node.start(now, start, length);
    node.onended = () => {
      if (source.current === node) {
        source.current = null;
        setPlaying(null);
      }
    };
    source.current = node;
    setPlaying({ at: start, startedAt: performance.now() });
  };
  function stop() {
    const node = source.current;
    source.current = null;
    if (node) {
      node.onended = null;
      try {
        node.stop();
      } catch {}
    }
    setPlaying(null);
  }
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function loop() {
      tick((n) => n + 1);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const capture = (e: ReactPointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };
  const timeAt = (e: ReactPointerEvent<HTMLElement>, from: number, to: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    return from + clamp((e.clientX - r.left) / r.width, 0, 1) * (to - from);
  };
  const detailDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!buffer || e.button !== 0) return;
    const t = timeAt(e, viewStart, viewStart + span);
    const handle = (e.target as HTMLElement).dataset.handle;
    capture(e);
    if (handle === 'left' || handle === 'right')
      drag.current = { mode: handle, offset: 0, end: start + length };
    else if (t >= start && t <= start + length)
      drag.current = { mode: 'move', offset: t - start, end: 0 };
    else {
      // A click outside the selection moves it there.
      select(t - length / 2, length);
      drag.current = { mode: 'move', offset: length / 2, end: 0 };
    }
  };
  const detailMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e, viewStart, viewStart + span);
    if (d.mode === 'move') select(t - d.offset, length);
    else if (d.mode === 'right') select(start, t - start);
    else {
      const s = clamp(t, Math.max(0, d.end - MAX), d.end - MIN);
      select(s, d.end - s);
    }
  };
  const overviewDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!buffer || e.button !== 0) return;
    capture(e);
    drag.current = { mode: 'move', offset: 0, end: 0 };
    overviewMove(e);
  };
  const overviewMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const t = timeAt(e, 0, duration);
    const s = clamp(t - length / 2, 0, duration - length);
    select(s, length);
    setViewStart(clamp(s + length / 2 - span / 2, 0, duration - span));
  };
  const keys = (e: KeyboardEvent) => {
    const step = e.altKey ? 0.1 : 0.5;
    const by = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!by) return;
    e.preventDefault();
    if (e.shiftKey) select(start, length + by);
    else select(start + by, length);
  };

  const pct = (t: number, from: number, to: number) => `${((t - from) / (to - from)) * 100}%`;
  const head =
    playing && buffer
      ? Math.min(start + length, playing.at + (performance.now() - playing.startedAt) / 1000)
      : null;
  const title = name.replace(/\.[a-z0-9]{2,5}$/i, '');

  if (error)
    return (
      <div className="song-clip">
        <p className="song-clip-error">{error}</p>
        <div className="song-clip-actions">
          <button type="button" className="st-button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  return (
    <div className="song-clip">
      <div className="song-clip-title">
        <span>{title}</span>
        <span className="song-clip-time">
          {buffer
            ? `${time(start)} – ${time(start + length)} · ${length.toFixed(1)} s`
            : 'Loading…'}
        </span>
      </div>
      {duration > SPAN && (
        <div
          className="song-clip-overview"
          onPointerDown={overviewDown}
          onPointerMove={overviewMove}
          onPointerUp={() => (drag.current = null)}
        >
          <canvas ref={overview} />
          <span
            className="song-clip-window"
            style={{ left: pct(viewStart, 0, duration), width: pct(span, 0, duration) }}
          />
        </div>
      )}
      <div
        className="song-clip-detail"
        onPointerDown={detailDown}
        onPointerMove={detailMove}
        onPointerUp={() => (drag.current = null)}
      >
        <canvas ref={detail} />
        {buffer && (
          <span
            className="song-clip-selection"
            role="slider"
            tabIndex={0}
            aria-label="Part of the song that plays. Arrow keys move it, Shift with arrows changes its length."
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(start)}
            aria-valuetext={`${time(start)} to ${time(start + length)}`}
            onKeyDown={keys}
            style={{
              left: pct(start, viewStart, viewStart + span),
              width: pct(length, 0, span),
            }}
          >
            <i data-handle="left" />
            <i data-handle="right" />
          </span>
        )}
        {head !== null && (
          <span
            className="song-clip-head"
            style={{ left: pct(head, viewStart, viewStart + span) }}
          />
        )}
      </div>
      <div className="song-clip-actions">
        <button
          type="button"
          className="st-button"
          disabled={!buffer}
          onClick={() => (playing ? stop() : play())}
        >
          {playing ? <Square size={11} fill="currentColor" strokeWidth={0} /> : <Play size={13} />}
          {playing ? 'Stop' : 'Listen'}
        </button>
        <span className="song-clip-hint">Drag the highlighted part or its edges.</span>
        <button type="button" className="st-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="st-button primary"
          disabled={!buffer || busy}
          onClick={() => {
            stop();
            onSave(encodeClip(buffer!, start, length), title);
          }}
        >
          {busy ? 'Saving…' : 'Use this part'}
        </button>
      </div>
    </div>
  );
}
