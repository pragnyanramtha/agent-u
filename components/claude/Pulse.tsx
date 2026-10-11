/* The 3×3 pixel grid from Beautiful UI's LoadingState, used as the live
 * indicator for sessions: the chevron wavefront runs while Claude is working
 * and rests as a dim mark when the session is open but idle. */

const CHEVRON = Array.from({ length: 9 }, (_, i) => (i % 3 + Math.abs(Math.floor(i / 3) - 1)) * 90);
const LIT_AT_REST = new Set([0, 4, 6]);

export function Pulse({ busy, size = 3, cellClass = "bg-ink" }: { busy: boolean; size?: number; cellClass?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 ${busy ? "pulse-busy" : ""}`} style={{ gridTemplateColumns: `repeat(3, ${size}px)`, gap: size / 3 + 0.5 }}>
      {CHEVRON.map((delay, i) => (
        <span
          key={i}
          className={`rounded-[1px] ${cellClass}`}
          style={{
            width: size,
            height: size,
            opacity: busy ? 0.15 : LIT_AT_REST.has(i) ? 0.75 : 0.18,
            animation: busy ? `pixel-on 650ms ease-in-out ${delay}ms infinite` : "none",
          }}
        />
      ))}
    </span>
  );
}
