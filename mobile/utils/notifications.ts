import * as Notifications from "expo-notifications";

export async function scheduleMemoryNotification(title: string, memoryId: number, date: Date) {
  return Notifications.scheduleNotificationAsync({ content: { title, body: "Memory reminder", data: { memoryId } }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date } });
}

export const cancelMemoryNotification = (id: string) => Notifications.cancelScheduledNotificationAsync(id);
