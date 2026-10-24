import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code as one SVG path, crisp at any board zoom. */
export function QrCode({ text, size }: { text: string; size: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let row = 0; row < count; row++)
      for (let col = 0; col < count; col++)
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    return { count, path };
  }, [text]);
  const margin = 2;
  return (
    <svg
      className="tg-qr"
      width={size}
      height={size}
      viewBox={`${-margin} ${-margin} ${count + margin * 2} ${count + margin * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code to sign in"
    >
      <rect
        x={-margin}
        y={-margin}
        width={count + margin * 2}
        height={count + margin * 2}
        fill="#fff"
      />
      <path d={path} fill="#111" />
    </svg>
  );
}
