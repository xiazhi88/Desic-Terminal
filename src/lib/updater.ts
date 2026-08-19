import { relaunch } from "@tauri-apps/plugin-process";
import type { AppUpdateState } from "../types";
import {
  applySourceAppUpdate,
  installAppUpdate,
  prepareAppUpdate,
  restartAfterSourceAppUpdate,
  listenOptional
} from "./tauri";

export type UpdateProgress = Readonly<{
  phase: "preparing" | "downloading" | "installing" | "restarting";
  downloaded: number;
  total: number | null;
}>;

export async function installAvailableUpdate(
  state: AppUpdateState,
  onProgress: (progress: UpdateProgress) => void
) {
  if (state.runtimeMode === "source") {
    onProgress({ phase: "preparing", downloaded: 0, total: null });
    const result = await applySourceAppUpdate();
    if (!result?.restartRequired) throw new Error("source update did not produce a restartable application");
    onProgress({ phase: "restarting", downloaded: 0, total: null });
    await restartAfterSourceAppUpdate();
    return;
  }

  onProgress({ phase: "preparing", downloaded: 0, total: null });
  await prepareAppUpdate();
  let downloaded = 0;
  let total: number | null = null;
  const unlisten = await listenOptional<{
    downloaded: number;
    total: number | null;
    finished: boolean;
  }>("app:update-download", (event) => {
    downloaded = event.downloaded;
    total = event.total;
    onProgress({
      phase: event.finished ? "installing" : "downloading",
      downloaded,
      total
    });
  });
  try {
    await installAppUpdate();
  } finally {
    unlisten?.();
  }
  onProgress({ phase: "restarting", downloaded, total });
  await relaunch();
}
