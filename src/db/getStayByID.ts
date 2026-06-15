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

export async function getStayByID(connStr: string, id: string | number): Promise<Stay | null> {
  if (!connStr) throw new Error('Connection string required');
  if (!id && id !== 0) throw new Error('Stay id required');
  
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  // Try raw string, then parsed config
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    console.error('Raw connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Check expected table exists
    const check = await req.query("SELECT OBJECT_ID('dbo.tbStays') AS objId");
    if (!check.recordset || !check.recordset[0] || !check.recordset[0].objId) {
      const tbls = await req.query("SELECT name FROM sys.tables ORDER BY name");
      const found = Array.isArray(tbls.recordset) ? tbls.recordset.map((r: any) => r.name).slice(0,20) : [];
      throw new Error(`Expected table 'tbStays' not found in database. Available tables: ${found.join(', ')}. Ensure the connection string points to the correct database and the schema/objects exist.`);
    }

    req.input('id', sql.Int, Number(id));

    const query = `
      SELECT
        S.EntryId, S.Title, 
        ISNULL(L.location_name,'MISSING') AS Region,
        S.City, CO.CountryName, S.CountryCode2Alpha, S.URL,
        S.GeoLat, S.GeoLng,
        S.Address, S.State, S.PostCode, S.TotalRooms AS NumberOfRooms,
        S.CheckinFrom, S.CheckoutTo, S.PetsAllowed, PD.AdditionalInformationDetailName AS PetsAllowedName, S.Description,
        S.MainImageName, S.ImageName, S.WorkspaceImageName, S.VideoName,
        S.WiFi_Download_Speed AS WiFiDownloadSpeed, 
        S.WiFi_Upload_Speed AS WiFiUploadSpeed, 
        S.WiFiJitter,
        CONVERT(varchar,S.WiFiLastUpdatedTime,0) AS WiFiLastUpdatedTime
      FROM tbStays S
      LEFT JOIN tbCountry CO ON S.Country = CO.CountryId
      LEFT JOIN Location L ON S.LocationID = L.location_id
      LEFT JOIN tbAdditionalInformationDetail PD ON PD.EntryID = S.PetsAllowed
      WHERE S.IsDeleted != 'true' AND S.EntryId = @id
      ORDER BY S.Title
      `; 

    const result = await req.query(query);
    let rec: any = (result.recordset as Stay[])[0];
    if (!rec) return null;

    if (rec.URL) {
      const u = String(rec.URL).trim();
      if (u && !/^https?:\/\//i.test(u)) rec.URL = `https://www.nomadstays.com/stay/${u}`;
    }

    // Build image URL(s)
    try {
      const images: string[] = [];
      const mainImgField = rec.MainImageName ?? rec.ImageName ?? null;
      const workImgField = rec.WorkspaceImageName ?? null;
      
      if (mainImgField) {
        // Split comma-separated image names
        const imgNames = String(mainImgField).split(',').map((s: string) => s.trim()).filter(Boolean);
        imgNames.forEach((name: string) => {
          images.push(`https://images.nomadstays.com/nomadstays/img/stay/${rec.EntryId}/${name}`);
        });
      }
      
      if (workImgField) {
        // Split comma-separated workspace image names
        const workImgNames = String(workImgField).split(',').map((s: string) => s.trim()).filter(Boolean);
        workImgNames.forEach((name: string) => {
          images.push(`https://images.nomadstays.com/nomadstays/img/stay/${rec.EntryId}/${name}`);
        });
      }
      
      rec.AllImages = images.length > 0 ? images : null;
      // Remove original database field names
      delete rec.MainImageName;
      delete rec.ImageName;
      delete rec.WorkspaceImageName;
      delete rec.OgImage;
    } catch { if (rec) { rec.AllImages = null; } }

    // Build video URL if video exists
    try {
      if (rec.VideoName) {
        rec.VideoUrl = `https://images.nomadstays.com/nomadstays/img/stay/${rec.EntryId}/${rec.VideoName}`;
        delete rec.VideoName;
      } else {
        rec.VideoUrl = null;
      }
    } catch { rec.VideoUrl = null; }

    // Add WiFi data
    try {
      rec.WiFiDownloadSpeed = rec.WiFiDownloadSpeed != null ? Number(rec.WiFiDownloadSpeed) : null;
      rec.WiFiUploadSpeed = rec.WiFiUploadSpeed != null ? Number(rec.WiFiUploadSpeed) : null;
      rec.WiFiJitter = rec.WiFiJitter != null ? Number(rec.WiFiJitter) : null;
    } catch { rec.WiFiDownloadSpeed = null; rec.WiFiUploadSpeed = null; rec.WiFiJitter = null; }

    // build amenities list
    try {
      const amenitiesRes = await req.query(`SELECT STRING_AGG(fd.FacilityDetailName, ',') AS amenities FROM tbStaysFacilities sf INNER JOIN tbFacilityDetails fd ON sf.FacilityDetailFK = fd.EntryID WHERE sf.StayFK = @id AND sf.IsDeleted = 0 AND fd.IsDeleted = 0 AND fd.FacilityFK != 9`);
      rec.StayFeatures = amenitiesRes.recordset && amenitiesRes.recordset[0] && amenitiesRes.recordset[0].amenities ? String(amenitiesRes.recordset[0].amenities).split(',').map((v: string)=>v.trim()).filter(Boolean) : null;
    } catch { rec.StayFeatures = null; }

    // Normalize pets flag to boolean
    try {
      if (rec.PetsAllowedName && typeof rec.PetsAllowedName === 'string') {
        const pn = String(rec.PetsAllowedName).toLowerCase();
        rec.PetsAllowed = (pn.includes('yes') || pn.includes('allow') || pn.includes('true') || pn === 'y' || pn === '1');
      } else if (rec.PetsAllowed == null) {
        rec.PetsAllowed = null;
      } else {
        const v = String(rec.PetsAllowed).trim();
        rec.PetsAllowed = (/^\d+$/.test(v) ? (Number(v) > 0) : (v.toLowerCase() === 'true'));
      }
    } catch { rec.PetsAllowed = null; }

    // Fetch min price and compute priceRange/priceCurrency
    try {
      const minQ = `SELECT MIN(sp.SellPrice) AS MinSellPrice, MIN(p.CurrencyFK) AS CurrencyFK, MAX(C.CurrencyCode) AS CurrencyCode FROM tbStayPrices sp INNER JOIN tbStayPackages p ON sp.StayPackagesFK = p.EntryID LEFT JOIN tbCurrencies C ON p.CurrencyFK = C.EntryID WHERE p.StayFK = @id AND sp.Listed = 1 AND sp.Days = 7`;
      const minRes = await req.query(minQ);
      const minRow = minRes.recordset && minRes.recordset[0] ? minRes.recordset[0] : null;
      const min = minRow && minRow.MinSellPrice != null ? Number(minRow.MinSellPrice) : null;
      const origCurrency = minRow && minRow.CurrencyCode ? String(minRow.CurrencyCode) : null;
      const targetCurrency = 'USD';
      const weekly = min != null ? Math.round(min) : null;

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
      } catch { }

      if (convertedWeeklyUsd != null) {
        rec.priceRange = `From ${targetCurrency} $${convertedWeeklyUsd} per week`;
        rec.priceCurrency = targetCurrency;
      } else if (origCurrency) {
        rec.priceRange = weekly != null ? `From ${origCurrency} ${weekly} per week` : null;
        rec.priceCurrency = origCurrency;
      } else {
        rec.priceRange = weekly != null ? `From ${targetCurrency} $${weekly} per week` : null;
        rec.priceCurrency = targetCurrency;
      }
    } catch { rec.priceRange = null; rec.priceCurrency = 'USD'; }

    // Fetch offers (similar to staydetail.cshtml)
    try {
      const offersQ = `
        SELECT sp.SellPrice, sp.Days, p.CurrencyFK, C.CurrencyCode AS CurrencyCode, p.RecordingDate, p.EndDate,
          p.PackageName AS OfferName,
          p.Description AS PackageDescription,
          COALESCE(r.RoomTitle, rt.RoomTypeName) AS RoomName
        FROM tbStayPrices sp
        INNER JOIN tbStayPackages p ON sp.StayPackagesFK = p.EntryID
        INNER JOIN tbStaysRoom r ON p.RoomTypeFK = r.RoomTypeFK AND p.StayFK = r.StayFK
        INNER JOIN tbRoomTypes rt ON p.RoomTypeFK = rt.EntryID
        LEFT JOIN tbCurrencies C ON p.CurrencyFK = C.EntryID
        WHERE p.StayFK = @id AND sp.Listed = 1
        ORDER BY sp.Days ASC`;
      const offersRes = await req.query(offersQ);
      rec.Offers = (offersRes.recordset || []).map((o: any)=>({ 
        '@type': 'Offer', 
        offername: o.OfferName ?? null,
        description: o.PackageDescription ?? null, 
        roomName: o.RoomName ?? null,
        price: o.SellPrice != null ? Number(o.SellPrice) : null, 
        priceCurrency: String(o.CurrencyCode ?? 'USD'), 
        validFrom: o.RecordingDate ? new Date(o.RecordingDate).toISOString().substring(0,10) : undefined, 
        validThrough: o.EndDate ? new Date(o.EndDate).toISOString().substring(0,10) : undefined, 
        availability: 'https://schema.org/InStock' 
      }));
    } catch { rec.Offers = null; }

    // Fetch rooms (containsPlace) with room-level amenities (similar to staydetail.cshtml)
    try {
      const roomsQ = `
        SELECT r.EntryID AS RoomId,
          COALESCE(r.RoomTitle, rt.RoomTypeName) AS RoomName,
          r.RoomFacilityFk
        FROM tbStaysRoom r
        LEFT JOIN tbRoomTypes rt ON rt.EntryID = r.RoomTypeFK
        WHERE r.StayFK = @id AND (r.IsDeleted = 'false' OR r.IsDeleted = 0)
        ORDER BY COALESCE(r.RoomTitle, rt.RoomTypeName)`;
      const roomsRes = await req.query(roomsQ);
      const containsPlaceRooms = [];
      
      for (const room of (roomsRes.recordset || [])) {
        const roomAmenities = [];
        const facilityFk = room.RoomFacilityFk;
        
        if (facilityFk) {
          try {
            const facilityIds = String(facilityFk).split(',').map((id: string) => id.trim()).filter(Boolean);
            if (facilityIds.length > 0) {
              const roomFacQ = `
                SELECT FacilityDetailName
                FROM tbFacilityDetails
                WHERE EntryID IN (${facilityIds.map((_, idx) => `@fid${idx}`).join(',')})
                  AND IsDeleted = 0
                ORDER BY FacilityDetailName`;
              const roomFacReq = pool.request();
              facilityIds.forEach((fid, idx) => {
                roomFacReq.input(`fid${idx}`, sql.Int, Number(fid));
              });
              const roomFacRes = await roomFacReq.query(roomFacQ);
              roomAmenities.push(...(roomFacRes.recordset || []).map((f: any) => ({ '@type': 'LocationFeatureSpecification', name: f.FacilityDetailName })));
            }
          } catch { /* ignore room amenity errors */ }
        }
        
        containsPlaceRooms.push({
          '@type': 'Accommodation',
          name: room.RoomName || 'Room',
          amenityFeature: roomAmenities.length > 0 ? roomAmenities : undefined
        });
      }
      
      rec.containsPlace = containsPlaceRooms.length > 0 ? containsPlaceRooms : null;
    } catch { rec.containsPlace = null; }

    try {
      // Coerce types
      rec.GeoLat = rec.GeoLat != null && rec.GeoLat !== '' ? Number(Number(rec.GeoLat).toFixed(6)) : null;
      rec.GeoLng = rec.GeoLng != null && rec.GeoLng !== '' ? Number(Number(rec.GeoLng).toFixed(6)) : null;
      rec.NumberOfRooms = rec.NumberOfRooms != null ? Number(rec.NumberOfRooms) : null;
      rec.StayId = rec.StayId != null ? Number(rec.StayId) : (rec.EntryId != null ? Number(rec.EntryId) : null);

      // Ensure offers and amenities are native types
      rec.StayFeatures = Array.isArray(rec.StayFeatures) ? rec.StayFeatures : (rec.StayFeatures ? [rec.StayFeatures] : null);
      rec.Offers = Array.isArray(rec.Offers) ? rec.Offers : (rec.Offers ? [rec.Offers] : null);

      // Build address object for JSON-LD if address fields exist
      const addr = (rec.Address || rec.PostCode || rec.State || rec.City) ? {
        '@type': 'PostalAddress',
        'streetAddress': rec.Address || '',
        'addressLocality': rec.City || '',
        'addressRegion': rec.State || '',
        'postalCode': rec.PostCode || '',
        'addressCountry': rec.CountryCode2Alpha || ''
      } : undefined;

      // Build canonical JSON-LD for single stay
      rec.jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'LodgingBusiness',
        'name': rec.Title,
        'description': rec.Description || '',
        'image': rec.AllImages && rec.AllImages.length ? rec.AllImages : undefined,
        'video': rec.VideoUrl ? { '@type': 'VideoObject', contentUrl: rec.VideoUrl, uploadDate: new Date().toISOString().substring(0,10) } : undefined,
        'address': addr,
        'geo': (rec.GeoLat != null && rec.GeoLng != null) ? { '@type': 'GeoCoordinates', latitude: rec.GeoLat, longitude: rec.GeoLng } : undefined,
        'numberOfRooms': rec.NumberOfRooms ?? undefined,
        'petsAllowed': rec.PetsAllowed ?? undefined,
        'checkinTime': rec.CheckinFrom ?? undefined,
        'checkoutTime': rec.CheckoutTo ?? undefined,
        'priceRange': rec.priceRange ?? undefined,
        'amenityFeature': rec.StayFeatures ? rec.StayFeatures.map((a: string) => ({ '@type': 'LocationFeatureSpecification', name: a })) : undefined,
        'offers': rec.Offers ? rec.Offers.map((o: any)=>({ '@type':'Offer', 'description': o.description, 'price': o.price, 'priceCurrency': o.priceCurrency, 'availability': o.availability, 'validFrom': o.validFrom, 'validThrough': o.validThrough })) : undefined,
        'containsPlace': rec.containsPlace ?? undefined
      };

      // Add compact summary
      rec.summary = {
        title: rec.Title ?? null,
        city: rec.City ?? null,
        lat: rec.GeoLat,
        lon: rec.GeoLng,
        priceRange: rec.priceRange ?? null,
        url: rec.URL ?? null,
        stayId: rec.StayId ?? null
      };

      // remove EntryId now that StayId is canonical
      try { delete rec.EntryId; } catch { }
    } catch { /* ignore */ }

    // Reorder keys so PetsAllowedName appears immediately after PetsAllowed when present
    // and make StayId the first property
    try {
      if (Object.prototype.hasOwnProperty.call(rec, 'PetsAllowedName')) {
        const nameVal = rec.PetsAllowedName;
        const ordered: any = {};
        // put StayId first (fall back to EntryId if StayId missing)
        ordered['StayId'] = rec.StayId ?? rec.EntryId ?? null;
        let inserted = false;
        for (const k of Object.keys(rec)) {
          if (k === 'PetsAllowedName' || k === 'StayId' || k === 'EntryId') continue;
          ordered[k] = (rec as any)[k];
          if (!inserted && k === 'PetsAllowed') {
            ordered['PetsAllowedName'] = nameVal;
            inserted = true;
          }
        }
        if (!inserted) ordered['PetsAllowedName'] = nameVal;
        rec = ordered;
      }
    } catch { /* ignore */ }

    return rec ?? null;
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
