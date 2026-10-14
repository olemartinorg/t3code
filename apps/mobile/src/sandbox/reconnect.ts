let reconnect: (() => Promise<void>) | null = null;
export function setPhoneReconnect(value: typeof reconnect) {
  reconnect = value;
}
export async function reconnectPhoneView() {
  if (!reconnect) throw new Error("Select the conversation again");
  await reconnect();
}
