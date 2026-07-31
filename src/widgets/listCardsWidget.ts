/**
 * ChatGPT Apps SDK widget shared by every tool that returns a plain array of records
 * with no natural single-object shape: listMyBookings, getMyStays, listStayApplications,
 * listExperienceApplications, listCoworkingApplications.
 *
 * Unlike stayResultsWidget/bookingWidget, these endpoints don't share a common field
 * schema — title lives under different keys (title/stayName/experienceName/coworkingName/
 * stayTitle) and there's no single status string, just booleans (listed/submitted/accepted)
 * or a nextAction sub-object (see Controllers/McpAgentApiController.cs,
 * McpStayApplicationApiController.cs, McpCoworkingApplicationApiController.cs,
 * McpExperienceApplicationApiController.cs, McpStayBookingApiController.cs in the main repo).
 * Rather than hardcode five field-name variants into the widget, each CallTool site passes
 * a small `hint` describing which keys to read, so the widget itself stays generic.
 */

export const LIST_CARDS_TEMPLATE_URI = "ui://widget/list-cards.html";

const widgetInvocationMeta = {
  "openai/toolInvocation/invoking": "Loading...",
  "openai/toolInvocation/invoked": "Loaded",
};

export const listCardsWidgetMeta = {
  "openai/outputTemplate": LIST_CARDS_TEMPLATE_URI,
  "openai/widgetAccessible": true,
  ...widgetInvocationMeta,
};

export const listCardsToolInvocationMeta = widgetInvocationMeta;

export interface ListCardsHint {
  /** Field to use as each card's title, e.g. "title" | "stayName" | "stayTitle" */
  titleField: string;
  /** Optional field holding a plain status string, e.g. listMyBookings' "status" */
  statusField?: string;
  /** Optional boolean fields rendered as badges when no statusField applies, e.g. ["listed"] or ["submitted","accepted"] */
  booleanFields?: string[];
  /** Optional field with a checkoutUrl-style action link, e.g. listMyBookings' "checkoutUrl" */
  actionUrlField?: string;
  /** Label for the action link, e.g. "Complete payment" */
  actionLabel?: string;
}

export function buildListCardsStructuredContent(items: any[], hint: ListCardsHint) {
  return { items, hint };
}

export const listCardsWidgetHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .list { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
  .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 12px 14px; }
  .title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: rgba(127,127,127,0.15); }
  .badge.positive { background: rgba(34,165,92,0.15); color: #22a55c; }
  .badge.negative { background: rgba(214,69,69,0.15); color: #d64545; }
  .action { display: inline-block; margin-top: 8px; font-size: 12px; font-weight: 600; text-decoration: none; padding: 6px 10px; border-radius: 6px; background: #111827; color: #fff; }
  @media (prefers-color-scheme: dark) { .action { background: #f3f4f6; color: #111827; } }
  .empty { padding: 24px; text-align: center; opacity: 0.6; font-size: 14px; }
</style>
</head>
<body>
<div id="root" class="list"></div>
<script>
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function statusBadge(text, positive) {
    return '<span class="badge ' + (positive ? "positive" : "negative") + '">' + escapeHtml(text) + '</span>';
  }

  function render(payload) {
    const root = document.getElementById("root");
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const hint = (payload && payload.hint) || {};

    if (items.length === 0) {
      root.className = "empty";
      root.textContent = "Nothing to show.";
      return;
    }

    root.className = "list";
    root.innerHTML = items.map(function (item) {
      var title = item[hint.titleField] || "Untitled";
      var badges = "";

      if (hint.statusField && item[hint.statusField] != null) {
        var s = String(item[hint.statusField]);
        badges += statusBadge(s, /paid|accepted|confirmed|listed/i.test(s));
      } else if (Array.isArray(hint.booleanFields)) {
        badges = hint.booleanFields.map(function (f) {
          return item[f] != null ? statusBadge(f + ": " + (item[f] ? "yes" : "no"), !!item[f]) : "";
        }).join("");
      }

      var action = "";
      if (hint.actionUrlField && item[hint.actionUrlField]) {
        action = '<a class="action" href="' + escapeHtml(item[hint.actionUrlField]) + '" target="_blank" rel="noopener">' +
          escapeHtml(hint.actionLabel || "Open") + '</a>';
      }

      return (
        '<div class="card">' +
          '<div class="title">' + escapeHtml(title) + '</div>' +
          (badges ? '<div class="badges">' + badges + '</div>' : "") +
          action +
        '</div>'
      );
    }).join("");
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
