import { useEffect, useRef } from "react";
import { useApp } from "ink";

/**
 * After a command machine reaches a terminal state, unmount Ink cleanly then exit the process.
 * Uses a short delay so the last frame (success or error text) renders before the TTY is released.
 *
 * Alternate screen is **opt-in** (`AGENT_CV_ALT_SCREEN=on`); when off (default), Ink uses the main
 * buffer so errors and progress show in normal scrollback and in Cursor terminal logs.
 *
 * If alt screen is on, Ink redraws in place and the final frame may not appear in scrollback. On
 * failure we leave the alternate screen and echo a plain-text line to stderr so the message is
 * still visible in logs.
 */
export function useInkTerminalExit(isTerminal: boolean, failed: boolean, failureMessage: string = ""): void {
  const { exit } = useApp();
  const altScreenActiveRef = useRef(false);

  useEffect(() => {
    const out = process.stdout;
    const useAltScreen = out.isTTY && process.env.AGENT_CV_ALT_SCREEN === "on";
    if (!useAltScreen) return;

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      out.write("\x1b[?1049l");
    };

    altScreenActiveRef.current = true;
    out.write("\x1b[?1049h\x1b[2J\x1b[H");
    process.once("exit", restore);

    return () => {
      process.off("exit", restore);
      restore();
      altScreenActiveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTerminal) return;
    const code = failed ? 1 : 0;
    const plainError = failureMessage.trim();
    const delayMs = failed && plainError ? 200 : 100;
    const t = setTimeout(() => {
      if (failed && plainError && altScreenActiveRef.current) {
        try {
          process.stdout.write("\x1b[?1049l");
        } catch {
          /* ignore */
        }
        altScreenActiveRef.current = false;
        process.stderr.write(`\nError: ${plainError}\n`);
      }
      exit();
      process.exit(code);
    }, delayMs);
    return () => clearTimeout(t);
  }, [isTerminal, failed, failureMessage, exit]);
}
