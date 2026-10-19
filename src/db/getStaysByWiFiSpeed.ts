import sql from 'mssql';
import { OPEN_ACCOUNT_STAY_FILTER, BOOKABLE_COLUMN, BOOKABLE_FIRST_ORDER, applyBookingStatus } from './stayVisibility.js';
import type { Stay } from '../types/stay.js';

export async function getStaysByWiFiSpeed(connStr: string, params: {
  minWiFiDownloadSpeed?: number;
  limit?: number;
}): Promise<Stay[]> {
  if (!connStr) throw new Error('Connection string required');
  const minSpeed = params.minWiFiDownloadSpeed ?? 10;
  const limit = params.limit ?? 15;

  let pool: any;
  try {
    pool = await sql.connect(connStr);
    const req = pool.request();
    req.input('minSpeed', sql.Float, minSpeed);
    req.input('limit', sql.Int, limit);
    const query = `
      SELECT TOP (@limit)
        S.EntryId,
        S.Title, S.AltTitle, S.ListingStatus, ${BOOKABLE_COLUMN},
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
        S.Country AS Country,
        CO.CountryName,
        CO.CountryCode2Alpha,
        S.WiFi_Download_Speed AS WiFiDownloadSpeed,
        S.WiFi_Upload_Speed AS WiFiUploadSpeed
      FROM tbStays S
      LEFT JOIN tbCountry CO ON S.Country = CO.CountryId
      WHERE ${OPEN_ACCOUNT_STAY_FILTER}
        AND (S.Suspended IS NULL OR S.Suspended = 0)
        AND S.WiFi_Download_Speed > @minSpeed
      ORDER BY ${BOOKABLE_FIRST_ORDER}, S.WiFi_Download_Speed DESC, S.Title
    `;
    const result = await req.query(query);
    for (const rec of result.recordset as any[]) {
      if (!rec) continue;
      applyBookingStatus(rec);
    }
    return result.recordset as Stay[];
  } finally {
    try { await pool.close(); } catch {}
  }
}
