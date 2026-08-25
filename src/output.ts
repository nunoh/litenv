export type StatusKind = "success" | "info" | "warning" | "error";

const RESET = "\u001b[0m";
const COLORS = {
  success: "\u001b[32m",
  info: "\u001b[36m",
  warning: "\u001b[33m",
  error: "\u001b[31m",
  strong: "\u001b[1m",
  heading: "\u001b[1;36m",
  dim: "\u001b[2m",
} as const;

export function paint(text: string, color: keyof typeof COLORS, enabled = false): string {
  return enabled ? `${COLORS[color]}${text}${RESET}` : text;
}

export function statusSymbol(kind: StatusKind, enabled = false): string {
  const symbols: Record<StatusKind, string> = { success: "✓", info: "○", warning: "⚠", error: "✗" };
  return paint(symbols[kind], kind, enabled);
}
