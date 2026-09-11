"use client";

/** Animated "typing…" indicator for one or more users. */
export function TypingDots({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-zinc-400" aria-live="polite">
      <span className="flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-400"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      <span>{label ?? "typing…"}</span>
    </div>
  );
}