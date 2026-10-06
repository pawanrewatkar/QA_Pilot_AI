import { SearchX } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Not found"
      description="The page or record you are looking for does not exist or has been deleted."
      action={
        <Button asChild>
          <Link href="/">Go to dashboard</Link>
        </Button>
      }
    />
  );
}
