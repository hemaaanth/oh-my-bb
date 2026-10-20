// Wraps raw PCM16 mono audio in a WAV header, so an <audio> element can play it.

const HEADER_BYTES = 44;

/** A RIFF/WAVE file: PCM, one channel, 16 bits, at `rate` Hz. */
export function wrapWav(pcm: Uint8Array, rate: number): Uint8Array {
  // PCM16 needs whole samples; a stray last byte is dropped.
  const length = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(HEADER_BYTES + length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, length, true);
  out.set(pcm.subarray(0, length), HEADER_BYTES);
  return out;
}
