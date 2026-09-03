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

/**
 * Checks whether a stay has ANY open booking window of at least minLengthOfStay days,
 * starting on or after fromDate and within windowDays of it — without looping day-by-day.
 * Gathers all busy intervals per eligible room (bookings + reservations) in one query,
 * then uses LAG() to find the largest gap between consecutive busy periods (and the gap
 * before the first / after the last) and checks it against minLengthOfStay in application code.
 */
export async function hasAvailabilityInWindow(connStr: string, params: {
  stayId: string | number;
  fromDate: string;
  windowDays: number;
  minLengthOfStay: number;
}) {
  if (!connStr) throw new Error('Connection string required');
  if (!params.stayId && params.stayId !== 0) throw new Error('Stay ID required');
  if (!params.fromDate) throw new Error('fromDate required');
  if (!params.minLengthOfStay) throw new Error('minLengthOfStay required');

  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  const fromDate = new Date(params.fromDate + 'T00:00:00Z');
  if (Number.isNaN(fromDate.getTime())) throw new Error('fromDate is invalid');
  const windowDays = Math.max(1, Number(params.windowDays) || 180);
  const minDays = Math.max(1, Number(params.minLengthOfStay));
  const toDate = new Date(fromDate);
  toDate.setUTCDate(toDate.getUTCDate() + windowDays);

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
    req.input('stayId', sql.Int, Number(params.stayId));
    req.input('fromDate', sql.Date, fromDate);
    req.input('toDate', sql.Date, toDate);

    // Eligible rooms: same eligibility rules as checkStayAvailability (Listed, not Suspended,
    // active package, room live, iCal healthy). One row per eligible room+package pair.
    const eligibleRoomsSql = `
      SELECT DISTINCT SR.EntryID AS RoomID, p.EntryID AS PackageID
      FROM tbStaysRoom SR
      INNER JOIN tbStayPackages p ON p.RoomTypeFK = SR.RoomTypeFK AND p.StayFK = SR.StayFK
      INNER JOIN tbStayPrices sp ON sp.StayPackagesFK = p.EntryID
      WHERE SR.StayFK = @stayId
        AND SR.IsDeleted = 0
        AND SR.ListingStatus = 'Live'
        AND SR.iCalLastError IS NULL
        AND p.IsActive = 1
        AND (p.Suspended IS NULL OR p.Suspended = 0)
        AND sp.Listed = 1
        AND (p.FixedStartDate IS NULL OR p.FixedStartDate = 0)
        AND p.EndDate >= @fromDate
    `;
    const eligibleResult = await req.query(eligibleRoomsSql);
    const eligibleRooms: { RoomID: number; PackageID: number }[] = eligibleResult.recordset || [];

    if (eligibleRooms.length === 0) {
      return { stayId: params.stayId, fromDate: params.fromDate, windowDays, minLengthOfStay: minDays, available: false, reason: 'no eligible rooms/packages' };
    }

    // Busy intervals (confirmed bookings + reservations not yet mirrored into tbBooking)
    // for all eligible packages, clipped to the search window.
    const packageIds = eligibleRooms.map(r => r.PackageID);
    const uniquePackageIds = [...new Set(packageIds)];
    const packageIdList = uniquePackageIds.join(',');

    const busySql = `
      SELECT PackageFK,
             CAST(CheckInDate AS DATE) AS BusyStart,
             CAST(DATEADD(Day, Night, CheckInDate) AS DATE) AS BusyEnd
      FROM tbBooking
      WHERE PackageFK IN (${packageIdList})
        AND IsConfirmed = 1
        AND IsDeleted = 0
        AND CAST(DATEADD(Day, Night - 1, CheckInDate) AS DATE) >= @fromDate
        AND CAST(CheckInDate AS DATE) <= @toDate

      UNION ALL

      SELECT R.PackageFK,
             CAST(R.CheckInDate AS DATE) AS BusyStart,
             CAST(DATEADD(Day, R.Night, R.CheckInDate) AS DATE) AS BusyEnd
      FROM tbBookingReservations R
      WHERE R.PackageFK IN (${packageIdList})
        AND R.IsConfirmed = 1
        AND ISNULL(R.IsDeleted, 0) = 0
        AND CAST(DATEADD(Day, R.Night - 1, R.CheckInDate) AS DATE) >= @fromDate
        AND CAST(R.CheckInDate AS DATE) <= @toDate
        AND NOT EXISTS (SELECT 1 FROM tbBooking B2 WHERE B2.BookingPNR = R.BookingPNR)

      ORDER BY PackageFK, BusyStart
    `;
    const busyReq = pool.request();
    busyReq.input('fromDate', sql.Date, fromDate);
    busyReq.input('toDate', sql.Date, toDate);
    const busyResult = await busyReq.query(busySql);
    const busyRows: { PackageFK: number; BusyStart: Date; BusyEnd: Date }[] = busyResult.recordset || [];

    // Group busy intervals by package, then find the largest free gap per package
    // (before first booking, between consecutive bookings, after last booking — clipped to window).
    const byPackage = new Map<number, { start: Date; end: Date }[]>();
    for (const row of busyRows) {
      const list = byPackage.get(row.PackageFK) ?? [];
      list.push({ start: new Date(row.BusyStart), end: new Date(row.BusyEnd) });
      byPackage.set(row.PackageFK, list);
    }

    const msPerDay = 24 * 60 * 60 * 1000;
    let earliestOpenDate: string | null = null;
    let found = false;

    for (const pkgId of uniquePackageIds) {
      const busy = (byPackage.get(pkgId) ?? []).sort((a, b) => a.start.getTime() - b.start.getTime());
      let cursor = new Date(fromDate);

      for (const interval of busy) {
        if (interval.start.getTime() > cursor.getTime()) {
          const gapDays = Math.floor((interval.start.getTime() - cursor.getTime()) / msPerDay);
          if (gapDays >= minDays) {
            found = true;
            const candidate = cursor.toISOString().slice(0, 10);
            if (!earliestOpenDate || candidate < earliestOpenDate) earliestOpenDate = candidate;
          }
        }
        if (interval.end.getTime() > cursor.getTime()) cursor = interval.end;
      }

      // Gap after the last booking, up to the end of the window
      if (cursor.getTime() < toDate.getTime()) {
        const gapDays = Math.floor((toDate.getTime() - cursor.getTime()) / msPerDay);
        if (gapDays >= minDays) {
          found = true;
          const candidate = cursor.toISOString().slice(0, 10);
          if (!earliestOpenDate || candidate < earliestOpenDate) earliestOpenDate = candidate;
        }
      }
    }

    return {
      stayId: params.stayId,
      fromDate: params.fromDate,
      windowDays,
      minLengthOfStay: minDays,
      available: found,
      earliestOpenCheckIn: earliestOpenDate
    };
  } finally {
    try { await pool.close(); } catch { }
  }
}
