import pc from "picocolors";

const ART = [
  " █████╗ ██╗   ██╗████████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "███████║██║   ██║   ██║   ██║   ██║██║     ██║   ██║██║  ██║█████╗  ",
  "██╔══██║██║   ██║   ██║   ██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ",
  "██║  ██║╚██████╔╝   ██║   ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];
const WIDTH = ART[0]!.length;

// xterm-256 rather than truecolor, which Terminal.app can't show
const GRADIENT = [51, 45, 39, 33, 63, 99, 135, 171, 207, 213];
const SHADOW = 60;

/** Empty when the terminal is too narrow to fit it without wrapping. */
export function logo(columns = process.stdout.columns ?? 80): string {
  if (columns <= WIDTH) return "";
  if (!pc.isColorSupported) return ART.join("\n");

  const span = WIDTH + ART.length * 2;
  return ART.map((row, y) => {
    let out = "";
    let active = -1;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const color = ch === "█" ? GRADIENT[Math.floor(((x + y * 2) / span) * GRADIENT.length)]! : SHADOW;
      if (ch !== " " && color !== active) {
        out += `\x1b[38;5;${color}m`;
        active = color;
      }
      out += ch;
    }
    return out + "\x1b[39m";
  }).join("\n");
}
