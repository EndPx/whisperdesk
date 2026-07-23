/**
 * WhisperDesk mark: three sound-wave arcs collapsing into a sealed vault
 * slot (a filled capsule with a keyway notch cut from its base) and a small
 * ice dot marking "sealed / verified". Monochrome metal — no color except
 * the ice dot. Reads cleanly at 24px.
 */
export function LogoMark({ className = "", size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="WhisperDesk mark"
    >
      {/* sound-wave arcs, tapering toward the slot */}
      <path
        d="M4 16a12 12 0 0 1 4.2-9.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path
        d="M7 16a9 9 0 0 1 3.1-6.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M10 16a6 6 0 0 1 2-4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      {/* sealed vault slot, with a keyway notch cut from its base */}
      <mask id="slot-mask">
        <rect x="14" y="6" width="10" height="20" rx="5" fill="white" />
        <rect x="17.5" y="17.5" width="3" height="4" fill="black" />
        <circle cx="19" cy="17" r="1.7" fill="black" />
      </mask>
      <rect x="14" y="6" width="10" height="20" rx="5" fill="currentColor" mask="url(#slot-mask)" />

      {/* ice "sealed" signal */}
      <circle cx="19" cy="9.5" r="1.4" fill="#7FE3F0" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="text-ink-2 shrink-0" size={26} />
      <span className="font-display font-semibold text-[1.25rem] tracking-tight text-ink">
        Whisper<span className="metal-sheen">Desk</span>
      </span>
    </span>
  );
}

export default Logo;
