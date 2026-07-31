/**
 * ChatGPT Apps SDK widget for tools that return a list of Stay results
 * (getStaysByLocation, getStaysByCountry, getStaysByContinent, getStaysByBudget,
 * getStaysByAmenities, getStaysByLifestyle, getStaysByWiFiSpeed).
 *
 * Follows the Apps SDK's "outputTemplate" contract: a tool declares
 * `_meta["openai/outputTemplate"]` pointing at a `ui://` resource; that resource is
 * served as `text/html+skybridge`; the CallTool response repeats the invocation _meta
 * and puts the data ChatGPT should render in `structuredContent` (the `content` text
 * item stays as the plain-JSON fallback for clients that don't render widgets, e.g.
 * Claude and the MCP Inspector).
 */

export const STAY_RESULTS_TEMPLATE_URI = "ui://widget/stay-results.html";

const widgetInvocationMeta = {
  "openai/toolInvocation/invoking": "Searching Nomad Stays...",
  "openai/toolInvocation/invoked": "Found stays",
};

export const stayResultsWidgetMeta = {
  "openai/outputTemplate": STAY_RESULTS_TEMPLATE_URI,
  "openai/widgetAccessible": true,
  ...widgetInvocationMeta,
};

export const stayResultsToolInvocationMeta = widgetInvocationMeta;

/**
 * Self-contained HTML/CSS/JS bundle rendered inline by ChatGPT. Reads the tool's
 * structuredContent via window.openai.toolOutput (per the Apps SDK widget surface)
 * and renders a simple results grid — no build step, no external requests, so it
 * satisfies the CSP review without any additional declared script/style domains
 * beyond the image CDN.
 */
export const stayResultsWidgetHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; padding: 12px; }
  .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; text-decoration: none; color: inherit; }
  .card img { width: 100%; height: 130px; object-fit: cover; background: rgba(127,127,127,0.1); }
  .card .body { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
  .card .title { font-weight: 600; font-size: 14px; line-height: 1.3; }
  .card .place { font-size: 12px; opacity: 0.7; }
  .card .price { font-size: 13px; font-weight: 600; margin-top: 4px; }
  .empty { padding: 24px; text-align: center; opacity: 0.6; font-size: 14px; }
</style>
</head>
<body>
<div id="root" class="grid"></div>
<script>
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(stays) {
    const root = document.getElementById("root");
    if (!Array.isArray(stays) || stays.length === 0) {
      root.className = "empty";
      root.textContent = "No stays found.";
      return;
    }
    root.className = "grid";
    root.innerHTML = stays.map(function (s) {
      const img = (s.AllImages && s.AllImages[0]) || "";
      const place = [s.City, s.CountryName].filter(Boolean).join(", ");
      const url = s.URL || "#";
      return (
        '<a class="card" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
          (img ? '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" />' : "") +
          '<div class="body">' +
            '<div class="title">' + escapeHtml(s.Title) + '</div>' +
            '<div class="place">' + escapeHtml(place) + '</div>' +
            (s.priceRange ? '<div class="price">' + escapeHtml(s.priceRange) + '</div>' : "") +
          '</div>' +
        '</a>'
      );
    }).join("");
  }

  function init() {
    const api = window.openai;
    const output = api && api.toolOutput;
    render(output && output.stays ? output.stays : []);
    if (api && typeof api.on === "function") {
      api.on("toolOutput", function (next) {
        render(next && next.stays ? next.stays : []);
      });
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
