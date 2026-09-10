"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Full-screen image viewer (Phase 9.3) — portal to <body>, Esc / backdrop
 * click to close, download link on the original (signed) URL.
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image viewer"
        className="absolute top-4 right-4 z-10 rounded-full bg-zinc-800/80 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-lg object-contain"
      />
      <a
        href={src}
        download
        onClick={(e) => e.stopPropagation()}
        className="mt-4 rounded-full bg-zinc-800 px-4 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700"
      >
        Download
      </a>
    </div>,
    document.body
  );
}