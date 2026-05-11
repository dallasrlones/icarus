import React, { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { palette } from "../theme";

const XTERM_CSS_ID = "icarus-xterm-css";
const XTERM_CSS_HREF = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css";

function ensureXtermCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(XTERM_CSS_ID)) return;
  const link = document.createElement("link");
  link.id = XTERM_CSS_ID;
  link.rel = "stylesheet";
  link.href = XTERM_CSS_HREF;
  document.head.appendChild(link);
}

interface Props {
  wsUrl: string;
}

/**
 * xterm.js + authenticated `/v1/shell` WebSocket. Keyboard input is sent as
 * binary UTF-8; resize messages are JSON `{ type: "resize", cols, rows }`.
 */
export function ShellTerminal({ wsUrl }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return undefined;
    ensureXtermCss();
    const el = hostRef.current;
    if (!el) return undefined;

    const ac = new AbortController();

    void (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (ac.signal.aborted) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Menlo", monospace',
        theme: {
          background: palette.bgDeep,
          foreground: palette.textPrimary,
          cursor: palette.cyan,
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();

      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";

      const sendResize = () => {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      };

      socket.onopen = () => {
        sendResize();
        term.focus();
      };

      socket.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
        if (typeof ev.data === "string") term.write(ev.data);
        else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      };

      socket.onerror = () => {
        term.writeln("\r\n\x1b[31m[websocket error]\x1b[0m");
      };

      socket.onclose = () => {
        term.writeln("\r\n\x1b[33m[connection closed]\x1b[0m");
      };

      term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });

      const onWinResize = () => sendResize();
      window.addEventListener("resize", onWinResize);
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sendResize) : null;
      ro?.observe(el);

      const onAbort = () => {
        window.removeEventListener("resize", onWinResize);
        ro?.disconnect();
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        try {
          term.dispose();
        } catch {
          /* ignore */
        }
      };
      ac.signal.addEventListener("abort", onAbort, { once: true });
    })();

    return () => ac.abort();
  }, [wsUrl]);

  return (
    <View style={styles.host}>
      {React.createElement("div", {
        ref: hostRef,
        style: {
          width: "100%",
          height: "100%",
          minHeight: 280,
          overflow: "hidden",
        },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    minHeight: 280,
    width: "100%",
  },
});
