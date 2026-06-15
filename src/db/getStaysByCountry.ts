import sql from 'mssql';
import type { Stay } from '../types/stay.js';

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


export async function getStaysByCountry(connStr: string, opts?: { country?: string | null, limit?: number }): Promise<Stay[]> {
  if (!connStr) throw new Error('Connection string required');
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');
  const limit = Math.max(1, Math.min(15, Number(opts?.limit ?? 15)));
  const country = opts?.country ?? null;

  // Log sanitized connection info (mask password)
  try {
    const masked = connStr.replace(/Password=[^;]*/i, 'Password=***');
    console.error(`getStaysByCountry connecting (sanitized): country=${country ?? 'null'} limit=${limit} conn=${masked}`);
    const parsed = parseConnectionString(connStr);
    console.error(`getStaysByCountry parsed config preview: server=${parsed.config.server ?? ''} port=${parsed.config.port ?? ''} db=${parsed.config.database ?? ''}`);
  } catch (e) {
    console.error('getStaysByCountry logging failed:', e);
  }

  // Try connecting using the connection string; on failure, try parsed config fallback
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      // helpful error when parsing fails
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    console.error('Connection string connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Quick check: ensure expected table exists to provide a helpful error if not
    const check = await req.query("SELECT OBJECT_ID('dbo.tbStays') AS objId");
    if (!check.recordset || !check.recordset[0] || !check.recordset[0].objId) {
      const tbls = await req.query("SELECT name FROM sys.tables ORDER BY name");
      const found = Array.isArray(tbls.recordset) ? tbls.recordset.map((r: any) => r.name).slice(0,20) : [];
      throw new Error(`Expected table 'tbStays' not found in database. Available tables: ${found.join(', ')}. Ensure the connection string points to the correct database and the schema/objects exist.`);
    }

    req.input('limit', sql.Int, limit);
    
    // Country filter: flexible search that matches country code or partial country names
    // Supports exact 2-letter codes (e.g., 'MA', 'US') or partial names (e.g., 'Antigua' matches 'Antigua and Barbuda')
    let whereCountry = '';
    if (country) {
      const searchTerm = String(country).trim();
      // Check if it's a 2-letter code (exact match) or a longer search term (partial match with LIKE)
      if (searchTerm.length === 2) {
        req.input('countrycode', sql.VarChar(10), searchTerm.toUpperCase());
        whereCountry = 'AND S.CountryCode2Alpha = @countrycode';
      } else {
        req.input('countrySearchPattern', sql.VarChar(100), `%${searchTerm}%`);
        whereCountry = 'AND (CO.CountryName LIKE @countrySearchPattern OR CO.FullCountryName LIKE @countrySearchPattern)';
      }
    }
    const query = `
      SELECT TOP (@limit)
        S.EntryId, S.Title,
        S.City, S.CountryCode2Alpha, S.URL, CO.CountryName,
        ISNULL(L.location_name,'MISSING') AS Region,
        S.GeoLat, S.GeoLng,
        S.Address, S.State, S.PostCode, S.TotalRooms AS NumberOfRooms,
        S.PetsAllowed, S.Description,
        S.MainImageName, S.ImageName,
        P.MinSellPrice AS MinPrice, P.CurrencyFK AS PriceCurrencyFK, P.CurrencyCode AS PriceCurrencyCode,
        -- aggregated amenities (comma separated)
        (SELECT STRING_AGG(fd.FacilityDetailName, ',') FROM tbStaysFacilities sf INNER JOIN tbFacilityDetails fd ON sf.FacilityDetailFK = fd.EntryID WHERE sf.StayFK = S.EntryId AND sf.IsDeleted = 0 AND fd.IsDeleted = 0 AND fd.FacilityFK != 9) AS Amenities,
        PD.AdditionalInformationDetailName AS PetsAllowedName,
        S.WiFi_Download_Speed AS WiFiDownloadSpeed
      FROM tbStays S
      LEFT JOIN tbCountry CO ON S.Country = CO.CountryId
      LEFT JOIN Location L ON S.LocationID = L.location_id
      LEFT JOIN tbAdditionalInformationDetail PD ON PD.EntryID = S.PetsAllowed
      LEFT JOIN (
        SELECT p.StayFK, MIN(sp.SellPrice) AS MinSellPrice, MIN(sp.Days) AS Days, MIN(p.CurrencyFK) AS CurrencyFK, MAX(C.CurrencyCode) AS CurrencyCode
        FROM tbStayPrices sp
        INNER JOIN tbStayPackages p ON sp.StayPackagesFK = p.EntryID
        LEFT JOIN tbCurrencies C ON p.CurrencyFK = C.EntryID
        WHERE sp.Listed = 1 AND sp.Days = 7
        GROUP BY p.StayFK
      ) P ON P.StayFK = S.EntryId
      WHERE S.IsDeleted != 'true' ${whereCountry}
      ORDER BY 
        CASE WHEN S.WiFi_Download_Speed IS NULL OR S.WiFi_Download_Speed = '' THEN 1 ELSE 0 END,
        S.WiFi_Download_Speed DESC,
        CASE WHEN P.MinSellPrice IS NULL THEN 1 ELSE 0 END,
        P.MinSellPrice DESC
    `; 

    const result = await req.query(query);
    // Prefix URL with full site path if it's present and not already absolute
    for (let i = 0; i < result.recordset.length; i++) {
      const r: any = result.recordset[i];
      // Skip undefined/null rows
      if (!r) continue;

      if (r.URL) {
        const u = String(r.URL).trim();
        if (u && !/^https?:\/\//i.test(u)) r.URL = `https://www.nomadstays.com/stay/${u}`;
      }

      // Build canonical og image url if we have an image name
      try {
        const imgField = r.MainImageName ?? r.ImageName ?? null;
        if (imgField) {
          // Split comma-separated image names
          const imgNames = String(imgField).split(',').map((s: string) => s.trim()).filter(Boolean);
          const imageUrls = imgNames.map((name: string) => `https://images.nomadstays.com/nomadstays/img/stay/${r.EntryId}/${name}`);
          r.AllImages = imageUrls.length > 0 ? imageUrls : null;
        } else {
          r.AllImages = null;
        }
        // Remove MainImageName and ImageName fields
        delete r.MainImageName;
        delete r.ImageName;
      } catch { if (r) { r.AllImages = null; } }

      // Split amenities into array
      try {
        if (r.Amenities && typeof r.Amenities === 'string') {
          r.StayFeatures = String(r.Amenities).split(',').map((v: string) => v.trim()).filter(Boolean);
        } else {
          r.StayFeatures = null;
        }
      } catch { r.StayFeatures = null; }

      // Normalize pets flag using PetsAllowedName when available (store boolean)
      try {
        if (r.PetsAllowedName && typeof r.PetsAllowedName === 'string') {
          const pn = String(r.PetsAllowedName).toLowerCase();
          // Prefer explicit negative phrases first (e.g., "not allowed", "no pets")
          if (/\b(no|not|not allowed|no pets|disallow|forbid|forbidden|prohibited)\b/.test(pn)) {
            r.PetsAllowed = false;
          } else if (/\b(yes|allow|allowed|true|y|1)\b/.test(pn)) {
            r.PetsAllowed = true;
          } else {
            r.PetsAllowed = null;
          }
        } else if (r.PetsAllowed == null) {
          r.PetsAllowed = null;
        } else {
          const v = String(r.PetsAllowed).trim();
          r.PetsAllowed = (/^\d+$/.test(v) ? (Number(v) > 0) : (v.toLowerCase() === 'true'));
        }
      } catch {
        r.PetsAllowed = null;
      }

      // Build priceRange and priceCurrency (convert to USD per week when exchange rates configured)
      try {
        const min = r.MinPrice != null ? Number(r.MinPrice) : null;
        const origCurrency = (r.PriceCurrencyCode ?? null) || null;
        const targetCurrency = 'USD';

        // MinPrice is already for 7 days (filtered in query), no need to multiply
        let weekly = min != null ? Math.round(min) : null;

        // support optional env var to provide conversion rates to USD, JSON map like {"EUR":1.08}
        let convertedWeeklyUsd: number | null = null;
        try {
          const ratesJson = process.env.NOMADSTAYS_EXCHANGE_RATES ?? null;
          if (ratesJson && origCurrency && origCurrency !== targetCurrency) {
            const rates = JSON.parse(ratesJson);
            const rateToUsd = rates[origCurrency];
            if (rateToUsd && typeof rateToUsd === 'number') {
              convertedWeeklyUsd = Math.round((min ?? 0) * rateToUsd);
            }
          }
        } catch { /* ignore malformed env */ }

        // Decide final range display
        if (convertedWeeklyUsd != null) {
          r.priceRange = `From ${targetCurrency} $${convertedWeeklyUsd} per week`;
          r.priceCurrency = targetCurrency;
        } else if (origCurrency) {
          // use original currency if we can't convert
          r.priceRange = weekly != null ? `From ${origCurrency} ${weekly} per week` : null;
          r.priceCurrency = origCurrency;
        } else {
          // default to USD using weekly numeric (no true conversion available)
          r.priceRange = weekly != null ? `From ${targetCurrency} $${weekly} per week` : null;
          r.priceCurrency = targetCurrency;
        }

        // Build minimal JSON-LD for listing consumers
        try {
          const addr: any = (r.Address || r.PostCode || r.State || r.City) ? {
            '@type': 'PostalAddress',
            'streetAddress': r.Address || '',
            'addressLocality': r.City || '',
            'addressRegion': r.State || '',
            'postalCode': r.PostCode || '',
            'addressCountry': r.CountryCode2Alpha || ''
          } : undefined;

          r.jsonLd = {
            '@context': 'https://schema.org',
            '@type': 'LodgingBusiness',
            'name': r.Title,
            'description': r.Description || '',
            'image': r.AllImages && r.AllImages.length ? r.AllImages : undefined,
            'address': addr,
            'geo': (r.GeoLat != null && r.GeoLng != null) ? { '@type': 'GeoCoordinates', latitude: Number(Number(r.GeoLat).toFixed(6)), longitude: Number(Number(r.GeoLng).toFixed(6)) } : undefined,
            'numberOfRooms': r.NumberOfRooms ?? undefined,
            'petsAllowed': r.PetsAllowed ?? undefined,
            'priceRange': r.priceRange ?? undefined,
            'offers': r.Offers ? r.Offers.map((o: any) => ({ '@type': 'Offer', 'description': o.description, 'price': o.price, 'priceCurrency': o.priceCurrency, 'availability': o.availability, 'validFrom': o.validFrom, 'validThrough': o.validThrough })) : undefined
          };
        } catch { r.jsonLd = null; }

        // Coerce primitive types into native JSON types for reliable agent consumption
        try {
          r.GeoLat = r.GeoLat != null && r.GeoLat !== '' ? Number(Number(r.GeoLat).toFixed(6)) : null;
          r.GeoLng = r.GeoLng != null && r.GeoLng !== '' ? Number(Number(r.GeoLng).toFixed(6)) : null;
          r.NumberOfRooms = r.NumberOfRooms != null ? Number(r.NumberOfRooms) : null;
          r.WiFiDownloadSpeed = r.WiFiDownloadSpeed != null && r.WiFiDownloadSpeed !== '' ? Number(r.WiFiDownloadSpeed) : null;
          r.StayId = r.StayId != null ? Number(r.StayId) : (r.EntryId != null ? Number(r.EntryId) : null);
          // ensure amenities is array or null (already handled earlier)
          r.StayFeatures = Array.isArray(r.StayFeatures) ? r.StayFeatures : (r.StayFeatures ? [r.StayFeatures] : null);
          // build a compact summary for quick agent reasoning
          r.summary = {
            title: r.Title ?? null,
            city: r.City ?? null,
            lat: r.GeoLat,
            lon: r.GeoLng,
            priceRange: r.priceRange ?? null,
            wifiDownloadSpeed: r.WiFiDownloadSpeed ?? null,
            url: r.URL ?? null,
            stayId: r.StayId ?? null
          };
        } catch { /* ignore */ }

        // remove raw numeric keys to avoid confusion
        try { delete r.MinPrice; } catch { }
        try { delete r.PriceCurrencyFK; } catch { }
        try { delete r.PriceCurrencyCode; } catch { }

        // Expose StayId (public identifier) and drop EntryId from responses
        try { r.StayId = r.EntryId; } catch { }
        try { delete r.EntryId; } catch { }
      } catch { /* ignore */ }

      // Reorder keys so PetsAllowedName appears immediately after PetsAllowed when present
      // and make StayId the first property
      try {
        if (Object.prototype.hasOwnProperty.call(r, 'PetsAllowedName')) {
          const nameVal = r.PetsAllowedName;
          const ordered: any = {};
          // put StayId first (fall back to EntryId if StayId missing)
          ordered['StayId'] = r.StayId ?? r.EntryId ?? null;
          let inserted = false;
          for (const k of Object.keys(r)) {
            if (k === 'PetsAllowedName' || k === 'StayId' || k === 'EntryId') continue; // skip original position or duplicates
            ordered[k] = r[k];
            if (!inserted && k === 'PetsAllowed') {
              ordered['PetsAllowedName'] = nameVal;
              inserted = true;
            }
          }
          if (!inserted) ordered['PetsAllowedName'] = nameVal;
          result.recordset[i] = ordered;
        }
      } catch { /* ignore */ }
    }
    return result.recordset as Stay[];
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}

/**
 * Get all available countries from the database
 */
export async function getAllCountries(connStr: string): Promise<Array<{ code: string, name: string, fullName: string }>> {
  if (!connStr) throw new Error('Connection string required');
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  // Log sanitized connection info (mask password)
  try {
    const masked = connStr.replace(/Password=[^;]*/i, 'Password=***');
    console.error(`getAllCountries connecting (sanitized): conn=${masked}`);
  } catch (e) {
    console.error('getAllCountries logging failed:', e);
  }

  // Try connecting using the connection string; on failure, try parsed config fallback
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    console.error('Connection string connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Check that the table exists
    const check = await req.query("SELECT OBJECT_ID('dbo.tbCountry') AS objId");
    if (!check.recordset || !check.recordset[0] || !check.recordset[0].objId) {
      throw new Error(`Expected table 'tbCountry' not found in database.`);
    }

    // Query to get distinct countries that have active stays
    const query = `
      SELECT DISTINCT 
        CO.CountryCode2Alpha AS code,
        CO.CountryName AS name,
        CO.FullCountryName AS fullName
      FROM tbCountry CO
      INNER JOIN tbStays S ON S.Country = CO.CountryId
      WHERE S.IsDeleted != 'true' 
        AND CO.CountryCode2Alpha IS NOT NULL 
        AND CO.CountryCode2Alpha != ''
      ORDER BY CO.CountryName
    `;

    const result = await req.query(query);
    
    return result.recordset.map((r: any) => ({
      code: String(r.code || '').trim(),
      name: String(r.name || '').trim(),
      fullName: String(r.fullName || r.name || '').trim()
    }));
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}

export async function getAllAmenities(connStr: string): Promise<Array<{ id: number, name: string, category: string | null }>> {
  if (!connStr) throw new Error('Connection string required');
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  // Log sanitized connection info (mask password)
  try {
    const masked = connStr.replace(/Password=[^;]*/i, 'Password=***');
    console.error(`getAllAmenities connecting (sanitized): conn=${masked}`);
  } catch (e) {
    console.error('getAllAmenities logging failed:', e);
  }

  // Try connecting using the connection string; on failure, try parsed config fallback
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    console.error('Connection string connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Check that the table exists
    const check = await req.query("SELECT OBJECT_ID('dbo.tbFacilityDetails') AS objId");
    if (!check.recordset || !check.recordset[0] || !check.recordset[0].objId) {
      throw new Error(`Expected table 'tbFacilityDetails' not found in database.`);
    }

    // Query to get all amenities/facilities (excluding facility type 9 which is typically used for other purposes)
    // Join with the parent facility table to get category information
    const query = `
      SELECT 
        fd.EntryID AS id,
        fd.FacilityDetailName AS name,
        f.FacilityName AS category
      FROM tbFacilityDetails fd
      LEFT JOIN tbFacilities f ON fd.FacilityFK = f.EntryID
      WHERE fd.IsDeleted = 0 
        AND fd.FacilityFK != 9
      ORDER BY f.FacilityName, fd.FacilityDetailName
    `;

    const result = await req.query(query);
    
    return result.recordset.map((r: any) => ({
      id: Number(r.id || 0),
      name: String(r.name || '').trim(),
      category: r.category ? String(r.category).trim() : null
    }));
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
