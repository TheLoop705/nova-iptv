// Browser voice input via the Web Speech API (Chrome, Edge, Safari).
// Browsers only grant the microphone on secure origins (https or localhost).

function recognizerCtor(): any {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechAvailable(): boolean {
  return !!recognizerCtor() && typeof window !== 'undefined' && window.isSecureContext;
}

export function startListening(onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void): () => void {
  const Ctor = recognizerCtor();
  if (!Ctor) {
    onEnd('Voice input is not supported in this browser');
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let ended = false;
  const finish = (err?: string) => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  rec.onresult = (ev: any) => {
    let text = '';
    let final = false;
    for (let i = 0; i < ev.results.length; i++) {
      text += ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final = true;
    }
    onText(text.trim(), final);
  };
  rec.onerror = (ev: any) => {
    const map: Record<string, string> = {
      'no-speech': "Didn't catch that — try again",
      'not-allowed': 'Microphone access was blocked',
      'service-not-allowed': 'Microphone access was blocked',
      'audio-capture': 'No microphone found',
      network: 'Voice recognition needs an internet connection',
    };
    finish(ev.error === 'aborted' ? undefined : (map[ev.error] ?? `Voice input failed (${ev.error})`));
  };
  rec.onend = () => finish();
  try {
    rec.start();
  } catch (e: any) {
    finish(e?.message ?? 'Voice input failed');
  }
  return () => {
    try {
      rec.abort();
    } catch {
      // already stopped
    }
  };
}
