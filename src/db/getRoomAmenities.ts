import sql from 'mssql';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
      port = parseInt(m[2], 10);
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

export async function getRoomAmenities(connStr: string, roomId: string | number) {
  if (!connStr) throw new Error('Connection string required');
  if (!roomId && roomId !== 0) throw new Error('Room ID required');
  
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
      throw new Error('Failed to derive server from connection string. Please ensure your connection string includes Server=...');
    }
    console.error('Raw connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();
    req.input('roomId', sql.Int, Number(roomId));

    // Get room details including facility IDs and parent stay info for WiFi metrics
    const roomQuery = `
      SELECT 
        SR.EntryID AS RoomID,
        COALESCE(SR.RoomTitle, RT.RoomTypeName) AS RoomName,
        RT.RoomTypeName,
        SR.RoomFacilityFk,
        SR.Beds,
        SR.Persons,
        SR.StayFK,
        S.WiFi_Download_Speed AS WiFiDownloadSpeed,
        S.WiFi_Upload_Speed AS WiFiUploadSpeed,
        S.WiFiJitter,
        ISL.Ping,
        CONVERT(varchar, S.WiFiLastUpdatedTime, 0) AS WiFiLastUpdatedTime
      FROM tbStaysRoom SR
      LEFT JOIN tbRoomTypes RT ON RT.EntryID = SR.RoomTypeFK
      LEFT JOIN tbStays S ON S.EntryId = SR.StayFK
      LEFT JOIN tbInternetSpeedLog ISL ON ISL.StayID = S.EntryId
      WHERE SR.EntryID = @roomId
      AND SR.IsDeleted = 0
    `;

    const roomResult = await req.query(roomQuery);
    
    if (!roomResult.recordset || roomResult.recordset.length === 0) {
      return {
        text: `Room ${roomId} not found or has been deleted`,
        content: []
      };
    }

    const room = roomResult.recordset[0];
    const facilities: string[] = [];

    // Parse facility IDs and fetch facility names
    if (room.RoomFacilityFk && String(room.RoomFacilityFk).trim()) {
      const facilityIds = String(room.RoomFacilityFk)
        .split(',')
        .map(id => id.trim())
        .filter(id => id && !isNaN(Number(id)))
        .map(id => Number(id));

      if (facilityIds.length > 0) {
        const facilityReq = pool.request();
        const placeholders = facilityIds.map((_, i) => `@fid${i}`).join(',');
        
        facilityIds.forEach((id, i) => {
          facilityReq.input(`fid${i}`, sql.Int, id);
        });

        const facilityQuery = `
          SELECT FacilityDetailName, Priority
          FROM tbFacilityDetails
          WHERE EntryID IN (${placeholders})
          AND (IsDeleted = 0 OR IsDeleted = 'false')
          ORDER BY Priority ASC, FacilityDetailName ASC
        `;

        const facilityResult = await facilityReq.query(facilityQuery);
        
        if (facilityResult.recordset) {
          facilities.push(...facilityResult.recordset.map((f: any) => f.FacilityDetailName));
        }
      }
    }

    // Build the response
    const amenities = {
      roomId: room.RoomID,
      roomName: room.RoomName || room.RoomTypeName || `Room ${room.RoomID}`,
      roomType: room.RoomTypeName,
      beds: room.Beds,
      persons: room.Persons,
      facilities: facilities,
      wifi: {
        downloadSpeed: room.WiFiDownloadSpeed ? `${room.WiFiDownloadSpeed} Mbps` : 'Not available',
        uploadSpeed: room.WiFiUploadSpeed ? `${room.WiFiUploadSpeed} Mbps` : 'Not available',
        jitter: room.WiFiJitter ? `${room.WiFiJitter} ms` : 'Not available',
        ping: room.Ping ? `${room.Ping} ms` : 'Not available',
        lastUpdated: room.WiFiLastUpdatedTime || 'Not available'
      }
    };

    // Create a formatted text response
    const textParts = [
      `Room: ${amenities.roomName}`,
      `Room Type: ${amenities.roomType || 'N/A'}`,
      `Beds: ${amenities.beds || 'N/A'}`,
      `Max Persons: ${amenities.persons || 'N/A'}`,
      '',
      'WiFi Information:',
      `  Download Speed: ${amenities.wifi.downloadSpeed}`,
      `  Upload Speed: ${amenities.wifi.uploadSpeed}`,
      `  Jitter: ${amenities.wifi.jitter}`,
      `  Ping: ${amenities.wifi.ping}`,
      `  Last Updated: ${amenities.wifi.lastUpdated}`,
      '',
      `Facilities (${facilities.length}):`,
      ...facilities.map(f => `  • ${f}`)
    ];

    if (facilities.length === 0) {
      textParts.push('  No facilities listed for this room');
    }

    return {
      text: textParts.join('\n'),
      content: [
        {
          type: 'text',
          text: JSON.stringify(amenities, null, 2)
        }
      ]
    };

  } finally {
    try {
      await pool.close();
    } catch (err) {
      // Ignore close errors
    }
  }
}
