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

export async function getAvailabilityByMonth(connStr: string, params: {
  stayId: string | number;
  year: number;
  month: number;
  minLengthOfStay: number;
}) {
  if (!connStr) throw new Error('Connection string required');
  if (!params.stayId && params.stayId !== 0) throw new Error('Stay ID required');
  if (!params.year) throw new Error('Year required');
  if (!params.month) throw new Error('Month required');
  if (params.month < 1 || params.month > 12) throw new Error('Month must be between 1 and 12');
  if (!params.minLengthOfStay) throw new Error('Minimum length of stay required');

  const monthStart = new Date(Date.UTC(params.year, params.month - 1, 1));
  const monthEnd = new Date(Date.UTC(params.year, params.month, 0));

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
      throw new Error(`Failed to connect: ${JSON.stringify(parsed.parts)}`);
    }
    console.error('Raw connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const totalRoomsReq = pool.request();
    totalRoomsReq.input('stayId', sql.Int, Number(params.stayId));
    const totalRoomsResult = await totalRoomsReq.query('SELECT COUNT(DISTINCT RoomTypeFK) as Total FROM tbStaysRoom WHERE StayFK = @stayId AND IsDeleted = 0');
    const totalRoomTypes = totalRoomsResult.recordset?.[0]?.Total ?? 0;

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

    const dailyAvailability: any[] = [];
    const cursorDate = new Date(monthStart);
    while (cursorDate <= monthEnd) {
      const checkIn = new Date(cursorDate);
      const checkOut = new Date(cursorDate);
      checkOut.setUTCDate(checkOut.getUTCDate() + params.minLengthOfStay);

      const req = pool.request();
      req.input('stayId', sql.Int, Number(params.stayId));
      req.input('checkInDate', sql.Date, checkIn);
      req.input('checkOutDate', sql.Date, checkOut);

      const res = await req.query(availabilitySql);
      const availableRoomTypes = res.recordset ? res.recordset.length : 0;

      dailyAvailability.push({
        Date: checkIn.toISOString().split('T')[0],
        AvailableRooms: availableRoomTypes,
        TotalRooms: totalRoomTypes
      });

      cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
    }

    const monthName = new Date(params.year, params.month - 1).toLocaleString('en-US', { month: 'long' });

    return {
      stayId: params.stayId,
      period: `${monthName} ${params.year}`,
      minLengthOfStay: params.minLengthOfStay,
      dailyAvailability
    };
  } finally {
    try { await pool.close(); } catch { }
  }
}
