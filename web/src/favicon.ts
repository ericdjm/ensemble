/** Draws a favicon with an attention count so the tab shows needs-input sessions at a glance. */
export function setFaviconBadge(count: number): void {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#171717";
  ctx.beginPath();
  ctx.roundRect(2, 2, 28, 28, 7);
  ctx.fill();
  ctx.fillStyle = "#e5e5e5";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("E", 16, 17);
  if (count > 0) {
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(24, 8, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#171717";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(count > 9 ? "9+" : String(count), 24, 9);
  }
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL("image/png");
}
