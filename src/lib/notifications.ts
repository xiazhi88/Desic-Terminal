import type { FeishuConfigSummary, FeishuConfigUpdate, NotificationSettingsSummary } from "../types";
import { invokeDesktop, invokeOptional } from "./tauri";

export function loadNotificationSettings(): Promise<NotificationSettingsSummary | null> {
  return invokeOptional<NotificationSettingsSummary>("notification_settings_summary");
}

export function saveFeishuConfig(config: FeishuConfigUpdate): Promise<FeishuConfigSummary | null> {
  return invokeDesktop<FeishuConfigSummary>("notification_feishu_config_save", { config });
}

export function testFeishuNotification(): Promise<unknown> {
  return invokeDesktop("notification_feishu_test");
}
