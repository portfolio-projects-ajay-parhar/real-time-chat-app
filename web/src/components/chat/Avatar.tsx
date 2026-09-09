"use client";

/**
 * Avatar from a storage key (served via the local media route) or initials.
 */
export function Avatar({
  name,
  imageKey,
  size = 40,
  online,
}: {
  name: string;
  imageKey?: string | null;
  size?: number;
  online?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span className="relative inline-flex shrink-0">
      {imageKey ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/media/${imageKey}`}
          alt={name}
          width={size}
          height={size}
          className="rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="flex items-center justify-center rounded-full bg-indigo-600/80 font-medium text-white"
          style={{ width: size, height: size, fontSize: size * 0.38 }}
        >
          {initials || "?"}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-label={online ? "online" : "offline"}
          className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-zinc-950 ${
            online ? "bg-emerald-500" : "bg-zinc-600"
          }`}
        />
      )}
    </span>
  );
}