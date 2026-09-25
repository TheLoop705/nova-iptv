import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

/** Lets the user pick a local .m3u file and returns its text (null if cancelled). */
export async function pickTextFile(): Promise<{ name: string; text: string } | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const text = await new File(asset.uri).text();
  return { name: asset.name, text };
}
