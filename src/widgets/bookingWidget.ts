/**
 * ChatGPT Apps SDK widget shared by quoteStayBooking, bookStay, and getBookingStatus.
 * Same outputTemplate contract as stayResultsWidget.ts.
 *
 * Renders whichever fields are present, since the three tools return different subsets
 * of the same conceptual "booking" object (see Controllers/McpStayBookingApiController.cs
 * in the main repo — quote/checkout/status responses are plain anonymous objects, not a
 * shared DTO, so the widget stays tolerant of missing fields rather than assuming a shape):
 *   quoteStayBooking -> { quoteId, stayTitle, packageName, checkIn, checkOut, nights,
 *                          rooms, adults, children, pets, currency, totalPrice, bookingFee,
 *                          payAtCheckIn, expiresInSeconds, note }
 *   bookStay          -> { pnr, checkoutUrl, amount, currency, note }
 *   getBookingStatus   -> { pnr, status, confirmationStatus, isConfirmed, amount }
 */

export const BOOKING_TEMPLATE_URI = "ui://widget/booking.html";

const widgetInvocationMeta = {
  "openai/toolInvocation/invoking": "Working on your booking...",
  "openai/toolInvocation/invoked": "Booking updated",
};

export const bookingWidgetMeta = {
  "openai/outputTemplate": BOOKING_TEMPLATE_URI,
  "openai/widgetAccessible": true,
  ...widgetInvocationMeta,
};

export const bookingToolInvocationMeta = widgetInvocationMeta;

export const bookingWidgetHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { margin: 12px; border: 1px solid rgba(127,127,127,0.25); border-radius: 12px; padding: 16px; max-width: 380px; }
  .title { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  .subtitle { font-size: 12px; opacity: 0.7; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; font-size: 13px; padding: 5px 0; }
  .row + .row { border-top: 1px solid rgba(127,127,127,0.15); }
  .row .label { opacity: 0.65; }
  .total { font-weight: 600; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; margin-bottom: 10px; }
  .badge.paid { background: rgba(34,165,92,0.15); color: #22a55c; }
  .badge.unpaid { background: rgba(214,69,69,0.15); color: #d64545; }
  .cta { display: block; margin-top: 12px; text-align: center; padding: 10px; border-radius: 8px; background: #111827; color: #fff; text-decoration: none; font-size: 13px; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .cta { background: #f3f4f6; color: #111827; } }
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

  function money(amount, currency) {
    if (amount == null) return "";
    return (currency ? currency + " " : "") + Number(amount).toFixed(2);
  }

  function render(b) {
    const root = document.getElementById("root");
    if (!b) {
      root.textContent = "No booking data.";
      return;
    }

    var html = "";

    if (b.status || b.confirmationStatus != null || b.isConfirmed != null) {
      var paid = b.isConfirmed || b.status === "paid";
      html += '<span class="badge ' + (paid ? "paid" : "unpaid") + '">' + escapeHtml(b.status || (paid ? "paid" : "unpaid")) + '</span>';
    }

    if (b.stayTitle) {
      html += '<div class="title">' + escapeHtml(b.stayTitle) + '</div>';
      if (b.packageName) html += '<div class="subtitle">' + escapeHtml(b.packageName) + '</div>';
    }

    var rows = [];
    if (b.pnr) rows.push(["Booking reference", b.pnr]);
    if (b.checkIn) rows.push(["Check-in", b.checkIn]);
    if (b.checkOut) rows.push(["Check-out", b.checkOut]);
    if (b.nights != null) rows.push(["Nights", b.nights]);
    if (b.rooms != null) rows.push(["Rooms", b.rooms]);
    if (b.totalPrice != null) rows.push(["Total price", money(b.totalPrice, b.currency)]);
    if (b.bookingFee != null) rows.push(["Booking fee (pay now)", money(b.bookingFee, b.currency)]);
    if (b.payAtCheckIn != null) rows.push(["Pay at check-in", money(b.payAtCheckIn, b.currency)]);
    if (b.amount != null && b.totalPrice == null) rows.push(["Amount", money(b.amount, b.currency)]);

    html += rows.map(function (r) {
      return '<div class="row"><span class="label">' + escapeHtml(r[0]) + '</span><span class="' + (r[0].indexOf("Total") === 0 ? "total" : "") + '">' + escapeHtml(r[1]) + '</span></div>';
    }).join("");

    if (b.checkoutUrl) {
      html += '<a class="cta" href="' + escapeHtml(b.checkoutUrl) + '" target="_blank" rel="noopener">Complete payment</a>';
    }

    if (b.note) {
      html += '<div class="subtitle" style="margin-top:10px;">' + escapeHtml(b.note) + '</div>';
    }

    root.innerHTML = html || "No booking data.";
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
