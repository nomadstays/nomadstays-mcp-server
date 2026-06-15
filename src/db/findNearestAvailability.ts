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

export async function findNearestAvailability(connStr: string, params: {
  stayId: string | number;
  preferredCheckIn: string;
  minLengthOfStay: number;
  maxLengthOfStay?: number;
  searchWindowDays?: number;
}) {
  if (!connStr) throw new Error('Connection string required');
  if (!params.stayId && params.stayId !== 0) throw new Error('Stay ID required');
  if (!params.preferredCheckIn) throw new Error('Preferred check-in date required');
  if (!params.minLengthOfStay) throw new Error('Minimum length of stay required');
  
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  const preferredDate = new Date(params.preferredCheckIn);
  if (Number.isNaN(preferredDate.getTime())) {
    throw new Error('Preferred check-in date is invalid');
  }

  const searchWindowDays = params.searchWindowDays ?? 90;
  const minDays = Math.max(1, params.minLengthOfStay);

  // Try raw string, then parsed config
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      throw new Error(`Failed to connect: ${JSON.stringify(parsed.parts)}`);
    }
    console.error('Raw connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const availabilitySql = `
      SELECT DISTINCT SR.EntryID as RoomID
      FROM tbStaysRoom SR
      WHERE SR.StayFK = @stayId
        AND SR.IsDeleted = 0
        AND EXISTS (
          SELECT 1 FROM tbStayPackages p
          WHERE p.RoomTypeFK = SR.RoomTypeFK
            AND p.StayFK = SR.StayFK
            AND p.IsActive = 1
            AND NOT EXISTS (
              SELECT 1 FROM tbBooking B
              WHERE B.PackageFK = p.EntryID
                AND B.IsConfirmed = 1
                AND B.IsDeleted = 0
                AND CAST(DATEADD(Day, B.Night - 1, B.CheckInDate) AS DATE) > @checkInDate
                AND CAST(B.CheckInDate AS DATE) < @checkOutDate
            )
        )
    `;

    const nearestOptions: any[] = [];
    const maxOptions = 30;
    for (let offset = 0; offset <= searchWindowDays; offset++) {
      const checkIn = new Date(preferredDate);
      checkIn.setDate(checkIn.getDate() + offset);

      const checkOut = new Date(checkIn);
      checkOut.setDate(checkOut.getDate() + minDays);

      const req = pool.request();
      req.input('stayId', sql.Int, Number(params.stayId));
      req.input('checkInDate', sql.Date, checkIn);
      req.input('checkOutDate', sql.Date, checkOut);

      const res = await req.query(availabilitySql);
      const availableRoomTypeIds = res.recordset ? res.recordset.map((r: any) => r.RoomID) : [];

      if (availableRoomTypeIds.length > 0) {
        nearestOptions.push({
          CheckIn: checkIn,
          CheckOut: checkOut,
          LengthOfStay: minDays,
          DaysFromPreferredDate: offset,
          roomTypeIds: availableRoomTypeIds
        });
      }

      if (nearestOptions.length >= maxOptions) break;
    }

    return {
      stayId: params.stayId,
      preferredCheckIn: params.preferredCheckIn,
      minLengthOfStay: minDays,
      searchWindowDays,
      nearestOptions
    };
  } finally {
    try { await pool.close(); } catch { }
  }
}
