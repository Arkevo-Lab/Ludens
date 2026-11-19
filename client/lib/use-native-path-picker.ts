import { useCallback, useEffect, useState } from "react";
import {
  canPickNativePath,
  pickNativePath,
  type DesktopPickPathOptions,
} from "./desktop";

export interface UseNativePathPickerResult {
  supported: boolean;
  picking: boolean;
  pickPath: (options: DesktopPickPathOptions) => Promise<string | null>;
}

export function useNativePathPicker(): UseNativePathPickerResult {
  const [supported, setSupported] = useState<boolean>(() => canPickNativePath());
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setSupported(canPickNativePath());
  }, []);

  const pickPath = useCallback(async (options: DesktopPickPathOptions): Promise<string | null> => {
    if (!canPickNativePath()) return null;
    setPicking(true);
    try {
      return await pickNativePath(options);
    } finally {
      setPicking(false);
    }
  }, []);

  return { supported, picking, pickPath };
}
