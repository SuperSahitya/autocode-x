import { Box, Text, useInput, usePaste } from "ink";
import pc from "picocolors";
import { useRef, useState } from "react";

export interface InputBoxProps {
  active: boolean;
  history: string[];
  commands: string[];
  onSubmit(text: string): void;
  onCtrlC(hadText: boolean): void;
  onEscape(): void;
}

interface EditorState {
  value: string;
  cursor: number;
}

const wordLeft = (s: string, i: number) => {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1]!)) j--;
  while (j > 0 && !/\s/.test(s[j - 1]!)) j--;
  return j;
};

export function InputBox({ active, history, commands, onSubmit, onCtrlC, onEscape }: InputBoxProps) {
  const [state, setState] = useState<EditorState>({ value: "", cursor: 0 });
  // keys can arrive faster than renders, so edits read from a ref rather than the last rendered state
  const current = useRef(state);
  // history index: history.length means "not browsing"
  const historyPos = useRef(history.length);
  const draft = useRef("");

  const set = (value: string, cursor = value.length) => {
    current.current = { value, cursor: Math.max(0, Math.min(cursor, value.length)) };
    setState(current.current);
  };
  const insert = (text: string) => {
    const { value, cursor } = current.current;
    set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  const pressReturn = () => {
    const { value } = current.current;
    // trailing backslash continues on a new line
    if (value.endsWith("\\")) return set(value.slice(0, -1) + "\n");
    if (!value.trim()) return;
    historyPos.current = history.length + 1;
    set("");
    onSubmit(value.trim());
  };

  usePaste((text) => insert(text.replace(/\r\n?/g, "\n")), { isActive: active });

  useInput(
    (input, key) => {
      const { value, cursor } = current.current;
      if (key.ctrl && input === "c") {
        onCtrlC(value.length > 0);
        set("");
        return;
      }
      if (key.escape) return onEscape();
      if (key.return) return pressReturn();
      // typed keys can arrive batched in one chunk (fast typing, slow links); Enter inside it still submits
      if (input.length > 1 && /[\r\n]/.test(input)) {
        input.split(/\r\n?|\n/).forEach((part, i) => {
          if (i > 0) pressReturn();
          if (part) insert(part);
        });
        return;
      }
      if (key.tab && value.startsWith("/")) {
        const match = commands.find((c) => c.startsWith(value));
        if (match) set(match + " ");
        return;
      }
      if (key.backspace) {
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) return set(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      if (key.leftArrow) return set(value, key.ctrl || key.meta ? wordLeft(value, cursor) : cursor - 1);
      if (key.rightArrow) return set(value, cursor + 1);
      if (key.home || (key.ctrl && input === "a")) return set(value, value.lastIndexOf("\n", cursor - 1) + 1);
      if (key.end || (key.ctrl && input === "e")) {
        const nl = value.indexOf("\n", cursor);
        return set(value, nl === -1 ? value.length : nl);
      }
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.ctrl && input === "w") {
        const j = wordLeft(value, cursor);
        return set(value.slice(0, j) + value.slice(cursor), j);
      }
      if ((key.upArrow || key.downArrow) && !value.includes("\n")) {
        if (historyPos.current > history.length) historyPos.current = history.length;
        if (historyPos.current === history.length) draft.current = value;
        const next = historyPos.current + (key.upArrow ? -1 : 1);
        if (next < 0 || next > history.length) return;
        historyPos.current = next;
        return set(next === history.length ? draft.current : history[next]!);
      }
      if (key.ctrl || key.meta || !input) return;
      insert(input.replace(/\r/g, ""));
    },
    { isActive: active },
  );

  const { value, cursor } = state;
  const before = value.slice(0, cursor);
  const at = value[cursor];
  const after = value.slice(cursor + 1);
  const cursorChar = active ? pc.inverse(at === undefined || at === "\n" ? " " : at) + (at === "\n" ? "\n" : "") : (at ?? "");
  const lines = (before + cursorChar + after).split("\n");

  const hints = value.startsWith("/") && !value.includes(" ") ? commands.filter((c) => c.startsWith(value)) : [];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={active ? "gray" : "blackBright"} paddingX={1}>
        <Text>
          {lines.map((l, i) => (i === 0 ? pc.green("❯ ") : "  ") + l).join("\n")}
          {!value && active ? pc.dim("Ask anything, or / for commands") : ""}
        </Text>
      </Box>
      {hints.length > 0 && <Text>{pc.dim(hints.map((h) => `  ${h}`).join("\n"))}</Text>}
    </Box>
  );
}
