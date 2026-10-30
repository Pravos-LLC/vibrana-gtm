export const REQUIRED_CONTENT: readonly string[];
export function contentMode(env?: Record<string, string | undefined>): 'sample' | 'private';
export function validateOverlay(env?: Record<string, string | undefined>): { mode: string; root: string; revision: string };
export function loadContent(name: string): any;
export function contentWritePath(name: string): string;
export function prepareContentBuild(env?: Record<string, string | undefined>): { mode: string; revision?: string };
export function writeContent(name: string, data: string | Buffer): void;
