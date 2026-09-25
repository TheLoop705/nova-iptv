import * as DocumentPicker from 'expo-document-picker';

/** Lets the user pick a local .m3u file and returns its text (null if cancelled). */
export async function pickTextFile(): Promise<{ name: string; text: string } | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['.m3u', '.m3u8', 'audio/x-mpegurl', 'application/x-mpegurl', 'text/plain'], multiple: false });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const text = asset.file ? await asset.file.text() : await (await fetch(asset.uri)).text();
  return { name: asset.name, text };
}
