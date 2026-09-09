"use client";

/** Animated "typing…" indicator for one or more users. */
export function TypingDots({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-zinc-400" aria-live="polite">
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      <span>{label ?? "typing…"}</span>
    </div>
  );
}