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

export async function getAllAmenities(connStr: string) {
  if (!connStr) throw new Error('Connection string required');
  
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

    // Query to get all amenities and categorize them based on IsStayFacility and IsRoomFacility flags
    const query = `
      SELECT 
        fd.EntryID,
        fd.FacilityDetailName,
        f.IsStayFacility,
        f.IsRoomFacility
      FROM tbFacilityDetails fd
      LEFT JOIN tbFacilities f ON fd.FacilityFK = f.EntryID
      WHERE (fd.IsDeleted = 0 OR fd.IsDeleted = 'false')
      ORDER BY fd.FacilityDetailName
    `;

    const result = await req.query(query);
    
    // Group amenities by facility type
    const stayAmenities: string[] = [];
    const roomAmenities: string[] = [];

    if (result.recordset && Array.isArray(result.recordset)) {
      for (const row of result.recordset) {
        const name = String(row.FacilityDetailName || '').trim();
        if (!name) continue;
        
        const isStay = row.IsStayFacility;
        const isRoom = row.IsRoomFacility;
        
        // Categorize based on the facility flags
        if (isRoom && (isRoom === 1 || isRoom === '1' || isRoom === true || isRoom === 'true')) {
          if (!roomAmenities.includes(name)) {
            roomAmenities.push(name);
          }
        } else if (isStay && (isStay === 1 || isStay === '1' || isStay === true || isStay === 'true')) {
          if (!stayAmenities.includes(name)) {
            stayAmenities.push(name);
          }
        } else {
          // Default to stay amenities if flags are not set
          if (!stayAmenities.includes(name)) {
            stayAmenities.push(name);
          }
        }
      }
    }

    // Format as text response
    const textParts = [];
    textParts.push(`Stay Amenities (${stayAmenities.length}):`);
    if (stayAmenities.length > 0) {
      textParts.push(...stayAmenities.map(a => `  • ${a}`));
    } else {
      textParts.push('  None listed');
    }
    
    textParts.push('');
    textParts.push(`Room Amenities (${roomAmenities.length}):`);
    if (roomAmenities.length > 0) {
      textParts.push(...roomAmenities.map(a => `  • ${a}`));
    } else {
      textParts.push('  None listed');
    }

    return {
      text: textParts.join('\n'),
      stayAmenities,
      roomAmenities
    };
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
