import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
/** Retain the last surface for its short exit transition, without retaining interactions. */
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(show),
    last = useRef(children);
  if (show) last.current = children;
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 140);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show && !mounted) return null;
  return (
    <div className={show ? 'presence-enter' : 'presence-exit'}>
      {show ? children : last.current}
    </div>
  );
}
