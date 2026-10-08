"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteProjectAction } from "@/app/projects/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/form-controls";

/** Confirmation dialog that requires typing the project name before deleting. */
export function DeleteProjectDialog({ projectId, projectName, compact }: { projectId: string; projectName: string; compact?: boolean }) {
  const [confirmText, setConfirmText] = useState("");
  const matches = confirmText.trim() === projectName.trim();

  return (
    <Dialog onOpenChange={(open) => !open && setConfirmText("")}>
      <DialogTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" aria-label={`Delete ${projectName}`} className="text-muted-foreground hover:text-destructive">
            <Trash2 />
          </Button>
        ) : (
          <Button variant="outline" className="text-destructive-text hover:text-destructive">
            <Trash2 /> Delete
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
          <DialogDescription>
            This permanently deletes <span className="font-medium text-foreground">{projectName}</span> and all of its configurations,
            pages, test runs, results, bugs, reports and uploaded documents. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form action={deleteProjectAction} className="grid gap-4">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-1.5">
            <Label htmlFor={`confirm-${projectId}`}>
              Type <span className="font-mono">{projectName}</span> to confirm
            </Label>
            <Input id={`confirm-${projectId}`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <SubmitButton variant="destructive" disabled={!matches} pendingLabel="Deleting…">
              Delete project
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
