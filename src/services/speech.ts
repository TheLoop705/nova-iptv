// Native platforms: voice goes through the system keyboard's own dictation
// (Fire TV: hold the remote's mic while the keyboard is open; iOS/Android: the keyboard mic key).
export function speechAvailable(): boolean {
  return false;
}

export function startListening(_onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void): () => void {
  onEnd('Voice input is not available here');
  return () => {};
}
