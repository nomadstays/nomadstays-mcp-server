import sql from 'mssql';
import type { Stay } from "../types/stay.js";

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

export async function getStaysByAmenities(connStr: string, params: {
  amenities: string[];
  matchType?: 'any' | 'all';
  minWifiSpeed?: number;
  limit?: number;
}): Promise<Stay[]> {
  if (!connStr) throw new Error('Connection string required');
  if (!params.amenities || params.amenities.length === 0) {
    throw new Error('At least one amenity is required');
  }

  const matchType = params.matchType || 'any'; // 'any' = OR, 'all' = AND
  const minWifiSpeed = params.minWifiSpeed || 0; // Minimum WiFi download speed in Mbps
  const limit = params.limit || 25;

  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect: ${JSON.stringify(parsed.parts)}`);
    }
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Normalize amenity names for comparison
    const normalizedAmenities = params.amenities
      .map(a => String(a).trim().toLowerCase())
      .filter(Boolean);

    // Expand user terms to actual facility names using fuzzy LIKE matching
    // e.g., user provides "gym" which matches "Fitness Center / Gym"
    let matchedAmenities: string[] = [];
    if (normalizedAmenities.length > 0) {
      const expReq = pool.request();
      const likeClauses: string[] = [];
      normalizedAmenities.forEach((term, i) => {
        // Basic wildcard search; could be enhanced with escaping if needed
        expReq.input(`term${i}`, sql.VarChar(255), `%${term}%`);
        likeClauses.push(`LOWER(fd.FacilityDetailName) LIKE @term${i}`);
      });
      const expQuery = `
        SELECT DISTINCT LOWER(fd.FacilityDetailName) AS Name
        FROM tbFacilityDetails fd
        WHERE (fd.IsDeleted = 0 OR fd.IsDeleted = 'false')
        AND (${likeClauses.join(' OR ')})
      `;
      const expRes = await expReq.query(expQuery);
      if (expRes.recordset && Array.isArray(expRes.recordset)) {
        matchedAmenities = expRes.recordset
          .map((r: any) => String(r.Name).trim().toLowerCase())
          .filter(Boolean);
      }
    }
    // Deduplicate and fallback to user terms if no expansion matches
    const deduped = Array.from(new Set(matchedAmenities)).filter(Boolean);
    matchedAmenities = deduped.length > 0 ? deduped : normalizedAmenities.slice();
    if (!matchedAmenities.length) {
      throw new Error('No amenity terms provided after normalization');
    }


    // Build amenity predicates based on matchType (any = OR, all = AND)
    const amenityOrClause = matchedAmenities.map((_, i) => `sa.AmenityName LIKE @amenity${i}`).join(' OR ');
    const amenityAllClause = matchedAmenities
      .map((_, i) => `EXISTS (SELECT 1 FROM StayAmenities sa WHERE sa.StayId = S.EntryId AND sa.AmenityName LIKE @amenity${i})`)
      .join(' AND ');

    // CTE consolidates stay- and room-level amenities for reuse
    const query = `
      WITH StayAmenities AS (
        SELECT sf.StayFK AS StayId, LOWER(fd.FacilityDetailName) AS AmenityName
        FROM tbStaysFacilities sf
        INNER JOIN tbFacilityDetails fd ON sf.FacilityDetailFK = fd.EntryID
        WHERE (sf.IsDeleted = 0 OR sf.IsDeleted = 'false')
          AND (fd.IsDeleted = 0 OR fd.IsDeleted = 'false')
        UNION ALL
        SELECT r.StayFK AS StayId, LOWER(rfd.FacilityDetailName) AS AmenityName
        FROM tbStaysRoom r
        CROSS APPLY STRING_SPLIT(r.RoomFacilityFk, ',') AS ss
        INNER JOIN tbFacilityDetails rfd ON rfd.EntryID = TRY_CAST(ss.value AS INT)
        WHERE r.IsDeleted = 0
          AND (rfd.IsDeleted = 0 OR rfd.IsDeleted = 'false')
      )
      SELECT
        S.EntryId,
        S.Title,
        S.City,
        S.State,
        S.PostCode,
        S.CountryCode2Alpha,
        S.GeoLat,
        S.GeoLng,
        S.Address,
        S.URL,
        S.MainImageName,
        S.ImageName,
        S.Description,
        S.TotalRooms AS NumberOfRooms,
        CO.CountryName,
        CO.CountryContinent,
        CAST(ISNULL(S.WiFi_Download_Speed, 0) AS FLOAT) AS WiFiDownloadSpeed,
        (
          SELECT STRING_AGG(names.FacilityDetailName, ', ')
          FROM (
            SELECT DISTINCT fd1.FacilityDetailName
            FROM tbStaysFacilities sf1
            INNER JOIN tbFacilityDetails fd1 ON sf1.FacilityDetailFK = fd1.EntryID
            WHERE sf1.StayFK = S.EntryId AND (sf1.IsDeleted = 0 OR sf1.IsDeleted = 'false') AND (fd1.IsDeleted = 0 OR fd1.IsDeleted = 'false')
            UNION
            SELECT DISTINCT fd2.FacilityDetailName
            FROM tbStaysRoom SR
            CROSS APPLY STRING_SPLIT(SR.RoomFacilityFk, ',') AS ss
            INNER JOIN tbFacilityDetails fd2 ON fd2.EntryID = TRY_CAST(ss.value AS INT)
            WHERE SR.StayFK = S.EntryId AND SR.IsDeleted = 0 AND (fd2.IsDeleted = 0 OR fd2.IsDeleted = 'false')
          ) AS names
        ) AS AmenitiesFound
      FROM tbStays S
      LEFT JOIN tbCountry CO ON S.Country = CO.CountryId
      WHERE S.IsDeleted != 'true'
        AND S.TotalRooms >= 1
        AND S.Listed = 1
        AND CAST(ISNULL(S.WiFi_Download_Speed, 0) AS FLOAT) >= @minWifiSpeed
        AND (
          ${matchType === 'all' ? amenityAllClause : `EXISTS (SELECT 1 FROM StayAmenities sa WHERE sa.StayId = S.EntryId AND (${amenityOrClause}))`}
        )
      ORDER BY S.Title
    `;

    // Add amenity parameters
    matchedAmenities.forEach((amenity, i) => {
      req.input(`amenity${i}`, sql.VarChar(255), `%${amenity}%`);
    });
    
    // Add WiFi speed parameter
    req.input('minWifiSpeed', sql.Float, minWifiSpeed);

    const result = await req.query(query);

    if (!Array.isArray(result.recordset)) {
      throw new Error('Expected resultset from tbStays query, got none');
    }

    // Format results
    const staysWithAmenities = result.recordset.map((r: any) => {
      const orderedStay = {
        EntryId: r.EntryId,
        Title: r.Title,
        City: r.City,
        State: r.State,
        PostCode: r.PostCode,
        CountryCode2Alpha: r.CountryCode2Alpha,
        GeoLat: r.GeoLat,
        GeoLng: r.GeoLng,
        Address: r.Address,
        URL: r.URL,
        MainImageName: r.MainImageName,
        ImageName: r.ImageName,
        Description: r.Description,
        NumberOfRooms: r.NumberOfRooms,
        CountryName: r.CountryName,
        CountryContinent: r.CountryContinent,
        WiFiDownloadSpeed: r.WiFiDownloadSpeed ? Number(r.WiFiDownloadSpeed) : null,
        AmenitiesFound: r.AmenitiesFound ? r.AmenitiesFound.split(', ') : []
      };
      return orderedStay;
    });

    // Apply limit
    return staysWithAmenities.slice(0, limit) as any[];
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
