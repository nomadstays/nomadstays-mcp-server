/**
 * ChatGPT Apps SDK widget for checkStayAvailability. Same outputTemplate contract as
 * stayResultsWidget.ts — see that file for the general shape of the convention.
 *
 * Data shape rendered comes straight from db/checkStayAvailability.ts's return value:
 * { stayId, checkIn, checkOut, available, availableRooms, totalRooms, roomTypeIds }.
 */

export const AVAILABILITY_TEMPLATE_URI = "ui://widget/availability.html";

const widgetInvocationMeta = {
  "openai/toolInvocation/invoking": "Checking availability...",
  "openai/toolInvocation/invoked": "Checked availability",
};

export const availabilityWidgetMeta = {
  "openai/outputTemplate": AVAILABILITY_TEMPLATE_URI,
  "openai/widgetAccessible": true,
  ...widgetInvocationMeta,
};

export const availabilityToolInvocationMeta = widgetInvocationMeta;

export const availabilityWidgetHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { margin: 12px; border: 1px solid rgba(127,127,127,0.25); border-radius: 12px; padding: 16px; max-width: 360px; }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; margin-bottom: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot.available { background: #22a55c; }
  .dot.unavailable { background: #d64545; }
  .row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; opacity: 0.85; }
  .row + .row { border-top: 1px solid rgba(127,127,127,0.15); }
</style>
</head>
<body>
<div id="root" class="card">Loading...</div>
<script>
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(a) {
    const root = document.getElementById("root");
    if (!a || typeof a.available !== "boolean") {
      root.textContent = "No availability data.";
      return;
    }
    root.innerHTML =
      '<div class="status"><span class="dot ' + (a.available ? "available" : "unavailable") + '"></span>' +
      (a.available ? "Available" : "Not available") + '</div>' +
      '<div class="row"><span>Check-in</span><span>' + escapeHtml(a.checkIn) + '</span></div>' +
      '<div class="row"><span>Check-out</span><span>' + escapeHtml(a.checkOut) + '</span></div>' +
      '<div class="row"><span>Room types available</span><span>' + escapeHtml(a.availableRooms) + ' / ' + escapeHtml(a.totalRooms) + '</span></div>';
  }

  function init() {
    const api = window.openai;
    render(api && api.toolOutput);
    if (api && typeof api.on === "function") {
      api.on("toolOutput", render);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
</script>
</body>
</html>`;
