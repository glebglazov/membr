type SpeechResult = { isFinal: boolean; [index: number]: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: { length: number; [index: number]: SpeechResult } };
export type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = new () => Recognition;
declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}
export function speechRecognition(): RecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}
