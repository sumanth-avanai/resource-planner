/**
 * ConfirmModal — title + one-line description, primary action right-aligned,
 * cancel to its left. Used for Generate invoice, delete confirmations,
 * booking create/edit confirmations.
 */
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "./button";

export interface ConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One-line description under the title. */
  description?: React.ReactNode;
  /** Optional extra content (e.g. an input for an invoice reference). */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger button style for destructive confirms. */
  destructive?: boolean;
  /** Disable the confirm button (e.g. while pending). */
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  onConfirm,
}: ConfirmModalProps) {
  const [pending, setPending] = React.useState(false);
  const handleConfirm = async () => {
    try {
      setPending(true);
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px] rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold text-navy">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {children}
        <DialogFooter className="mt-2 gap-2 sm:justify-end">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            size="sm"
            onClick={handleConfirm}
            disabled={confirmDisabled || pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
