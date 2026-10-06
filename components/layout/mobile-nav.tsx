"use client";

import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogTrigger, DrawerContent } from "@/components/ui/dialog";
import { Brand } from "./brand";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </DialogTrigger>
      <DrawerContent title="Navigation" className="bg-sidebar text-sidebar-foreground">
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
          <Brand onNavigate={close} />
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-white" aria-label="Close navigation">
              <X />
            </Button>
          </DialogClose>
        </div>
        <SidebarNav onNavigate={close} />
      </DrawerContent>
    </Dialog>
  );
}
