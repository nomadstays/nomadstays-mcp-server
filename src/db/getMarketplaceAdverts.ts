import sql from 'mssql';

function parseConnectionString(connStr: string) {
  // Normalize and strip surrounding quotes
  connStr = String(connStr).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  // Parse basic key=value; pairs into a config object suitable for mssql
  const parts = connStr.split(';').map(p => p.trim()).filter(Boolean);
  const map: Record<string, string> = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    const val = p.slice(idx + 1).trim();
    map[key] = val;
  }

  // Try to derive server from map or first part
  let server = '';
  let port: number | undefined = undefined;
  if (map['server']) {
    server = map['server'].replace(/^tcp:/i, '');
  } else if (parts.length > 0) {
    // first part might be 'Server=tcp:host,1433' or just 'tcp:host,1433'
    const first = parts[0];
    const mFirst = first.match(/(?:server\s*=\s*)?(?:tcp:)?([^,;]+)/i);
    if (mFirst) server = mFirst[1];
  }

  if (server) {
    // strip unexpected prefixes and surrounding quotes
    server = String(server).replace(/^\s*["']+\s*/, '').replace(/\s*["']+\s*$/, '');
    server = server.replace(/^server\s*=\s*/i, '').replace(/^tcp:\/\//i, '').replace(/^tcp:/i, '');
    const m = server.match(/([^,:]+)[,:](\d+)/);
    if (m) {
      server = m[1];
      port = Number(m[2]);
    }
    server = server.trim();
  }

  const user = map['user id'] || map['uid'] || map['username'] || map['user'];
  const password = map['password'] || map['pwd'];
  const database = map['database'] || map['initial catalog'];

  const encrypt = (map['encrypt'] || '').toLowerCase() === 'true';
  const trustServerCertificate = (map['trustservercertificate'] || '').toLowerCase() === 'true';

  const config: any = {
    server,
    options: {
      encrypt: !!encrypt,
      trustServerCertificate: !!trustServerCertificate
    }
  };
  if (port) config.port = port;
  if (user) config.user = user;
  if (password) config.password = password;
  if (database) config.database = database;

  return { config, parts, map };
}

export interface MarketplaceAdvert {
  Title: string;
  Description: string | null;
  Category: string | null;
  ImageUrl: string | null;
  URL: string | null;
}

/**
 * Returns Nomad Marketplace adverts (tbAdverts) — third-party partner deals/services
 * shown at nomadstays.com/nomad-marketplace. Distinct from Stays (accommodation).
 * Mirrors the site's own visibility rule: Listed + ActiveListed + has an image, and the
 * advertiser is either on a free listing or has an active paid subscription.
 */
export async function getMarketplaceAdverts(
  connStr: string,
  opts?: { category?: string | null; limit?: number }
): Promise<MarketplaceAdvert[]> {
  if (!connStr) throw new Error('Connection string required');
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  const limit = Math.max(1, Math.min(50, Number(opts?.limit ?? 20)));
  const category = opts?.category ?? null;

  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();
    req.input('limit', sql.Int, limit);

    let whereCategory = '';
    if (category) {
      req.input('categoryPattern', sql.VarChar(sql.MAX), `%${String(category).trim()}%`);
      whereCategory = 'AND C.AdCatTitle LIKE @categoryPattern';
    }

    const query = `
      SELECT TOP (@limit)
        At.EntryId AS AdId,
        At.AdvertiserFK AS AdvertiserId,
        At.AdTitle AS Title,
        At.AdDescription AS Description,
        At.ImageName,
        At.URL,
        C.AdCatTitle AS Category
      FROM tbAdverts At
      INNER JOIN tbAdvertisers V ON At.AdvertiserFK = V.AdvertiserId
      LEFT JOIN tbAdvertisingCategory C ON At.AdvertisingCategory = C.AdCatID
      WHERE At.Listed = '1' AND At.ActiveListed = '1' AND At.ImageName IS NOT NULL
        AND V.AdvertiserListed = '1'
        AND (V.IsFreeListing = 1 OR (ISNULL(V.SubActive, 0) = 1 AND V.SubEndDate > GETDATE()))
        ${whereCategory}
      ORDER BY At.EntryId DESC
    `;

    const result = await req.query(query);

    return result.recordset.map((r: any) => {
      const imageNameRaw = String(r.ImageName ?? '');
      const firstImage = imageNameRaw.includes(',') ? imageNameRaw.split(',')[0].trim() : imageNameRaw.trim();

      const desc = String(r.Description ?? '');

      return {
        Title: String(r.Title ?? ''),
        Description: desc.length > 250 ? desc.slice(0, 250) : (desc || null),
        Category: r.Category ?? null,
        ImageUrl: firstImage ? `https://images.nomadstays.com/nomadstays/img/advertising/${r.AdId}/${firstImage}` : null,
        // Routes through nomadstays.com so the click is attributed/tracked
        // (tbAdvertClicks) before forwarding to the advertiser's real URL —
        // never expose At.URL directly.
        URL: `https://www.nomadstays.com/ad/${r.AdId}`
      } as MarketplaceAdvert;
    });
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
