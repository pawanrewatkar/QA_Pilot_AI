"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Something went wrong"
      description={
        <>
          The page could not be loaded. {error.digest ? <span className="font-mono text-xs">Reference: {error.digest}</span> : null}
        </>
      }
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
