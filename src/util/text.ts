const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - half * 2;
  const omittedLines = text.slice(half, text.length - half).split("\n").length - 1;
  return `${text.slice(0, half)}\n\n... [${omitted} chars / ~${omittedLines} lines truncated] ...\n\n${text.slice(-half)}`;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`).join("\n");
}
