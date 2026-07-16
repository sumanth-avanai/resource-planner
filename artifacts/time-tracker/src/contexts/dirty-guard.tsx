import { createContext, useContext, useRef, useState, useCallback, ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface DirtyGuardContextValue {
  isDirty: boolean;
  reportDirty: (dirty: boolean) => void;
  registerSave: (fn: () => void) => void;
  registerClearDirty: (fn: () => void) => void;
  unregister: () => void;
  guardNavigate: (action: () => void) => void;
  consumePendingNavAfterSave: () => (() => void) | null;
}

const DirtyGuardContext = createContext<DirtyGuardContextValue>({
  isDirty: false,
  reportDirty: () => {},
  registerSave: () => {},
  registerClearDirty: () => {},
  unregister: () => {},
  guardNavigate: (action) => action(),
  consumePendingNavAfterSave: () => null,
});

export function useDirtyGuard() {
  return useContext(DirtyGuardContext);
}

export function DirtyGuardProvider({ children }: { children: ReactNode }) {
  const [isDirty, setIsDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const saveHandlerRef = useRef<(() => void) | null>(null);
  const clearDirtyHandlerRef = useRef<(() => void) | null>(null);
  const pendingNavAfterSaveRef = useRef<(() => void) | null>(null);

  const reportDirty = useCallback((dirty: boolean) => setIsDirty(dirty), []);

  const registerSave = useCallback((fn: () => void) => {
    saveHandlerRef.current = fn;
  }, []);

  const registerClearDirty = useCallback((fn: () => void) => {
    clearDirtyHandlerRef.current = fn;
  }, []);

  const unregister = useCallback(() => {
    saveHandlerRef.current = null;
    clearDirtyHandlerRef.current = null;
    setIsDirty(false);
  }, []);

  const guardNavigate = useCallback(
    (action: () => void) => {
      if (!isDirty) {
        action();
        return;
      }
      setPendingAction(() => action);
    },
    [isDirty]
  );

  const consumePendingNavAfterSave = useCallback(() => {
    const fn = pendingNavAfterSaveRef.current;
    pendingNavAfterSaveRef.current = null;
    return fn;
  }, []);

  const handleSaveAndContinue = () => {
    if (!pendingAction) return;
    pendingNavAfterSaveRef.current = pendingAction;
    setPendingAction(null);
    saveHandlerRef.current?.();
  };

  const handleDiscard = () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    clearDirtyHandlerRef.current?.();
    action();
  };

  const handleCancel = () => {
    setPendingAction(null);
  };

  return (
    <DirtyGuardContext.Provider
      value={{
        isDirty,
        reportDirty,
        registerSave,
        registerClearDirty,
        unregister,
        guardNavigate,
        consumePendingNavAfterSave,
      }}
    >
      {children}
      <AlertDialog open={pendingAction !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You have unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              What would you like to do with your unsaved changes before leaving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="ghost" onClick={handleCancel} className="sm:mr-auto">
              Cancel
            </Button>
            <Button variant="outline" onClick={handleDiscard}>
              Discard
            </Button>
            <Button onClick={handleSaveAndContinue}>
              Save &amp; Continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DirtyGuardContext.Provider>
  );
}
