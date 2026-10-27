import type { Reaction, RoomMessage } from "./contract";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_WINDOW_SIZE = 150;
export type TranscriptPage = {
  messages: RoomMessage[];
  parents: RoomMessage[];
  reactions: Reaction[];
  hasOlder: boolean;
  hasNewer: boolean;
};
