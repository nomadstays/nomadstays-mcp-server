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

export interface Lifestyle {
  GenreID: number;
  GenreTitle: string;
  GenreDescription: string | null;
}

export async function getAllLifestyles(connStr: string): Promise<Lifestyle[]> {
  if (!connStr) throw new Error('Connection string required');
  // Be forgiving: trim accidental leading '=' or whitespace that users may paste,
  // strip surrounding quotes and convert common port mistake ';1433;' to ',1433;'
  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

  // Log sanitized connection info (mask password)
  try {
    const masked = connStr.replace(/Password=[^;]*/i, 'Password=***');
    console.error(`getAllLifestyles connecting (sanitized): conn=${masked}`);
    const parsed = parseConnectionString(connStr);
    console.error(`getAllLifestyles parsed config preview: server=${parsed.config.server ?? ''} port=${parsed.config.port ?? ''} db=${parsed.config.database ?? ''}`);
  } catch (e) {
    console.error('getAllLifestyles logging failed:', e);
  }

  // Try connecting using the connection string; on failure, try parsed config fallback
  let pool: any;
  try {
    pool = await sql.connect(connStr);
  } catch (err) {
    const parsed = parseConnectionString(connStr);
    const cfg = parsed.config;
    if (!cfg.server) {
      // helpful error when parsing fails
      throw new Error(`Failed to connect using connection string and parsing returned no server. Parsed parts: ${JSON.stringify(parsed.parts)}; map keys: ${Object.keys(parsed.map).join(', ')}`);
    }
    console.error('Connection string connect failed; retrying with parsed config', { server: cfg.server, port: cfg.port, database: cfg.database });
    pool = await sql.connect(cfg as any);
  }

  try {
    const req = pool.request();

    // Quick check: ensure expected table exists to provide a helpful error if not
    const check = await req.query("SELECT OBJECT_ID('dbo.tbGenre') AS objId");
    if (!check.recordset || !check.recordset[0] || !check.recordset[0].objId) {
      const tbls = await req.query("SELECT name FROM sys.tables ORDER BY name");
      const found = Array.isArray(tbls.recordset) ? tbls.recordset.map((r: any) => r.name).slice(0,20) : [];
      throw new Error(`Expected table 'tbGenre' not found in database. Available tables: ${found.join(', ')}. Ensure the connection string points to the correct database and the schema/objects exist.`);
    }

    const query = `
      SELECT 
        GenreID,
        GenreTitle,
        GenreDescription
      FROM tbGenre
      WHERE (IsActive IS NULL OR IsActive = 'true')
      ORDER BY GenreTitle ASC
    `;

    const result = await req.query(query);
    
    // Process results
    const lifestyles: Lifestyle[] = result.recordset.map((r: any) => ({
      GenreID: r.GenreID != null ? Number(r.GenreID) : null,
      GenreTitle: r.GenreTitle ?? null,
      GenreDescription: r.GenreDescription ?? null
    }));

    return lifestyles;
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
