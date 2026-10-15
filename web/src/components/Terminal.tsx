import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const DARK = { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#e5e5e5" };
const LIGHT = { background: "#ffffff", foreground: "#171717", cursor: "#171717" };

/** xterm.js attached to /ws/term for one tmux target. Each mount is its own attach client. */
export function Terminal({ target, focus }: { target: string; focus?: boolean }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: dark ? DARK : LIGHT,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    if (focus) term.focus();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(
      `${proto}://${location.host}/ws/term?target=${encodeURIComponent(target)}&cols=${term.cols}&rows=${term.rows}`,
    );
    sock.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let open = false;
    sock.onopen = () => {
      open = true;
    };
    sock.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) term.write(decoder.decode(ev.data));
      else {
        try {
          const msg = JSON.parse(String(ev.data)) as { t: string; message?: string };
          if (msg.t === "error") term.writeln(`\r\n[terminal error: ${msg.message ?? "unknown"}]`);
        } catch {
          /* ignore */
        }
      }
    };
    sock.onclose = () => {
      open = false;
      term.writeln("\r\n[disconnected]");
    };
    const dataSub = term.onData((d) => {
      if (open) sock.send(encoder.encode(d));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (open) sock.send(JSON.stringify({ t: "resize", cols, rows }));
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not visible */
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      sock.close();
      term.dispose();
    };
  }, [target, focus]);

  return (
    <div
      ref={container}
      className="h-full min-h-[40vh] w-full overflow-hidden rounded-md bg-white dark:bg-neutral-950"
    />
  );
}
