import type { RepositoryEntry, RepositoryFileResult } from "../../shared/contracts";

export interface OpenFile {
  entry: RepositoryEntry;
  tab: HTMLElement;
  result?: RepositoryFileResult;
  error?: string;
  scrollTop: number;
  line: number | null;
}
