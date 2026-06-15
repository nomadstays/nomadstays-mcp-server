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

export async function getRoomAvailability(connStr: string, params: {
  roomId: string | number;
  checkIn: string;
  checkOut: string;
}) {
  if (!connStr) throw new Error('Connection string required');
  if (!params.roomId && params.roomId !== 0) throw new Error('Room ID required');
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
    const checkInDate = new Date(params.checkIn);
    const checkOutDate = new Date(params.checkOut);
    
    const req = pool.request();
    req.input('roomId', sql.Int, Number(params.roomId));
    req.input('checkInDate', sql.Date, params.checkIn);
    req.input('checkOutDate', sql.Date, params.checkOut);
    
    // Get the stay and room info first to find the room's StayFK and RoomTypeFK
    const roomInfoQuery = `
      SELECT TOP 1 SR.StayFK, SR.RoomTypeFK
      FROM tbStaysRoom SR
      WHERE SR.EntryID = @roomId
      AND SR.IsDeleted = 0
    `;
    
    const roomInfoResult = await req.query(roomInfoQuery);
    if (!roomInfoResult.recordset || roomInfoResult.recordset.length === 0) {
      return {
        roomId: params.roomId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        totalNights: 0,
        availableNights: 0,
        availability: [],
        error: 'Room not found'
      };
    }
    
    const { StayFK, RoomTypeFK } = roomInfoResult.recordset[0];
    
    req.input('stayId', sql.Int, StayFK);
    req.input('roomTypeFK', sql.Int, RoomTypeFK);
    
    // Query to check availability accounting for:
    // a) standard allocation (room quantity in tbStayPackages)
    // b) blocked dates (rooms with no available bookings)
    // c) bookings (confirmed, non-deleted bookings that block the room)
    // A booking blocks a room from CheckInDate through CheckInDate + Night - 1
    const availabilityQuery = `
      DECLARE @CheckDate DATE = @checkInDate
      DECLARE @EndDate DATE = @checkOutDate
      
      CREATE TABLE #DateRange (CheckDate DATE)
      WHILE @CheckDate < @EndDate
      BEGIN
        INSERT INTO #DateRange VALUES (@CheckDate)
        SET @CheckDate = DATEADD(day, 1, @CheckDate)
      END
      
      SELECT 
        dr.CheckDate,
        CASE WHEN EXISTS (
          SELECT 1 FROM tbStayPackages p
          WHERE p.RoomTypeFK = @roomTypeFK
          AND p.StayFK = @stayId
          AND p.IsActive = 1
          AND NOT EXISTS (
            SELECT 1 FROM tbBooking B
            WHERE B.PackageFK = p.EntryID
            AND B.IsConfirmed = 1
            AND B.IsDeleted = 0
            AND CAST(B.CheckInDate AS DATE) <= dr.CheckDate
            AND CAST(DATEADD(Day, B.Night - 1, B.CheckInDate) AS DATE) >= dr.CheckDate
          )
        ) THEN 1 ELSE 0 END as Available
      FROM #DateRange dr
      ORDER BY dr.CheckDate
      
      DROP TABLE #DateRange
    `;
    
    const result = await req.query(availabilityQuery);
    const records = result.recordset || [];
    
    let availableNightsCount = 0;
    const nightAvailability = records.map((record: any) => {
      const available = record.Available === 1;
      if (available) availableNightsCount++;
      
      const checkDate = new Date(record.CheckDate);
      const formattedDate = `${String(checkDate.getDate()).padStart(2, '0')}/${String(checkDate.getMonth() + 1).padStart(2, '0')}/${checkDate.getFullYear()}`;
      
      return {
        date: record.CheckDate.toISOString().split('T')[0],
        displayDate: formattedDate,
        available: available ? 1 : 0
      };
    });
    
    return {
      roomId: params.roomId,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      totalNights: nightAvailability.length,
      availableNights: availableNightsCount,
      availability: nightAvailability
    };
  } finally {
    try { await pool.close(); } catch { }
  }
}
