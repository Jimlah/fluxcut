export interface TrimRange {
  start: number;
  end: number;
}

export interface FileMeta {
  duration: number;
  w: number;
  h: number;
  poster: string;
}

export type Status = "idle" | "loading" | "converting" | "done";

export interface ResultInfo {
  name: string;
  size: number;
  url: string;
  codec: string;
  dims: { width: number; height: number };
}
