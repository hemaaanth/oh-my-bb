// The two call chimes (SPEC §6.4): a rising one when a Dispatch call goes
// live and a falling one when it ends. Web Audio makes them, so the plugin
// ships no sound files. They play on the default output.
let context: AudioContext | null = null;

function play(frequencies: number[]) {
  if (typeof AudioContext === "undefined") return;
  // A chime must never break the call it announces.
  try {
    context ??= new AudioContext();
    void context.resume().catch(() => undefined);
    const start = context.currentTime;
    frequencies.forEach((frequency, index) => {
      const at = start + index * 0.07;
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.13, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      oscillator.connect(gain).connect(context!.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.27);
    });
  } catch {}
}

/** Rising three notes: the call is live and listening. */
export const playReadyChime = () => play([659, 784, 1047]);
/** Falling three notes: the call ended. */
export const playHangUpChime = () => play([1047, 784, 659]);
