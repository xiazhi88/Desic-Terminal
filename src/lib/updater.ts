import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AppUpdateState } from "../types";
import {
  applySourceAppUpdate,
  prepareAppUpdate,
  restartAfterSourceAppUpdate
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
  const update = await check();
  if (!update) throw new Error("the signed update manifest no longer reports an available update");
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      onProgress({ phase: "downloading", downloaded, total });
      return;
    }
    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ phase: "downloading", downloaded, total });
      return;
    }
    if (event.event === "Finished") {
      onProgress({ phase: "installing", downloaded, total });
    }
  });
  onProgress({ phase: "restarting", downloaded, total });
  await relaunch();
}
