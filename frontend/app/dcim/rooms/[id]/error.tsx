"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function RoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[DCIM Room Error]", error);
  }, [error]);

  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-red-500 p-6">
      <AlertTriangle className="h-10 w-10" />
      <p className="font-semibold text-lg">Error al cargar la sala</p>
      <p className="text-sm text-slate-600 max-w-md text-center font-mono bg-slate-100 px-3 py-2 rounded">
        {error?.message ?? "Error desconocido"}
      </p>
      {error?.digest && (
        <p className="text-xs text-slate-400">digest: {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="mt-2 rounded-none border border-red-300 px-4 py-2 text-sm hover:bg-red-50"
      >
        Reintentar
      </button>
    </div>
  );
}
