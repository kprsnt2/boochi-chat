/** Boochi 👻 — the little ghost shown when Private + Temp are both on. */
export function Ghost({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`ghost ${className}`}
    >
      <path
        d="M12 2.5c-4.4 0-7.5 3.3-7.5 7.7v10.3c0 .7.8 1.1 1.4.7l1.6-1.2 1.7 1.3c.4.3.9.3 1.3 0L12 20l1.5 1.3c.4.3.9.3 1.3 0l1.7-1.3 1.6 1.2c.6.4 1.4 0 1.4-.7V10.2c0-4.4-3.1-7.7-7.5-7.7Z"
        fill="currentColor"
        opacity=".95"
      />
      <ellipse cx="9.3" cy="10.4" rx="1.35" ry="1.8" fill="var(--ghost-eye, #1b1530)" />
      <ellipse cx="14.7" cy="10.4" rx="1.35" ry="1.8" fill="var(--ghost-eye, #1b1530)" />
      <path d="M10.6 14.2c.8.6 2 .6 2.8 0" stroke="var(--ghost-eye, #1b1530)" strokeWidth="1.1" fill="none" strokeLinecap="round" />
    </svg>
  );
}
