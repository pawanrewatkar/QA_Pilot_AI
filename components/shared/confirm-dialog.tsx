"use client";

import * as React from "react";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/**
 * Asks for confirmation, then submits a server action with the given hidden fields.
 * Extra form controls (e.g. a note) can be passed as children.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  action,
  fields,
  confirmLabel,
  pendingLabel,
  destructive,
  children,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          action={async (fd) => {
            await action(fd);
            setOpen(false);
          }}
          className="grid gap-4"
        >
          {Object.entries(fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {children}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <SubmitButton variant={(destructive ? "destructive" : "default") as ButtonProps["variant"]} pendingLabel={pendingLabel}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
