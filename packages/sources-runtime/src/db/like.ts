export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}

