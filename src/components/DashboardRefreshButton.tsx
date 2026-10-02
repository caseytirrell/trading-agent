"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function DashboardRefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  function refreshDashboard() {
    startTransition(() => {
      router.refresh();
      setLastRefreshedAt(new Date());
    });
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        type="button"
        onClick={refreshDashboard}
        disabled={isPending}
        className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Refreshing..." : "Refresh Alpaca Data"}
      </button>

      {lastRefreshedAt && (
        <p className="text-xs text-neutral-500">
          Last refreshed {lastRefreshedAt.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
