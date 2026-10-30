export declare const RELEVANT: RegExp;
export declare function upstreamChangeIsRelevant(
  f: { filename: string; status?: string; patch?: string; previous_filename?: string },
  vendored: string[],
  fetchBody: (filename: string) => string,
): boolean;
