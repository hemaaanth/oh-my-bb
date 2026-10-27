// Pi RPC image payload; the bridge does not load the Pi runtime in its own process.
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
