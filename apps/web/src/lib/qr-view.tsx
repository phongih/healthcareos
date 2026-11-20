import { useMemo } from 'react';

import { encodeQr, qrPath, type EccLevel } from './qr';

/** Mã QR dạng SVG (không ảnh, không thư viện ngoài; hợp CSP). */
export function QrCode({ text, ecl = 'M', size = 200, label }: { text: string; ecl?: EccLevel; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const m = encodeQr(text, ecl);
    return { n: m.size + 8, d: qrPath(m, 4) };
  }, [text, ecl]);
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
