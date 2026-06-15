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

export async function checkStayAvailability(connStr: string, params: {
  stayId: string | number;
  checkIn: string;
  checkOut: string;
  roomType?: string;
}) {
  if (!connStr) throw new Error('Connection string required');
  if (!params.stayId && params.stayId !== 0) throw new Error('Stay ID required');
  if (!params.checkIn) throw new Error('Check-in date required');
  if (!params.checkOut) throw new Error('Check-out date required');

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
    const req = pool.request();
    req.input('stayId', sql.Int, Number(params.stayId));
    req.input('checkInDate', sql.Date, params.checkIn);
    req.input('checkOutDate', sql.Date, params.checkOut);

    // Check availability - get list of available room types
    const availQuery = `
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
      ORDER BY SR.EntryID
    `;
    
    const result = await req.query(availQuery);
    const availableRoomTypeIds = result.recordset ? result.recordset.map((r: any) => r.RoomID) : [];
    
    // Get total room types for this stay
    const totalReq = pool.request();
    totalReq.input('stayId', sql.Int, Number(params.stayId));
    const totalResult = await totalReq.query('SELECT COUNT(DISTINCT RoomTypeFK) as Total FROM tbStaysRoom WHERE StayFK = @stayId AND IsDeleted = 0');
    const totalRoomTypes = totalResult.recordset?.[0]?.Total ?? 0;
    
    const availableRoomTypes = availableRoomTypeIds.length;
    
    return {
      stayId: params.stayId,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      available: availableRoomTypes > 0,
      availableRooms: availableRoomTypes,
      totalRooms: totalRoomTypes,
      roomTypeIds: availableRoomTypeIds,
      details: { availableRoomTypeIds, totalRoomTypes }
    };
  } finally {
    try { await pool.close(); } catch { }
  }
}
