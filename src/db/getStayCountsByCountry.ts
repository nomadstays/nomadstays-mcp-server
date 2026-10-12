import sql from 'mssql';

export interface StayCountByCountry {
  country: string;
  countryCode: string | null;
  continent: string | null;
  /** Stays with a live public listing in this country. */
  stays: number;
  /** Of those, stays that are currently listed for booking and not suspended. */
  bookableNow: number;
}

export async function getStayCountsByCountry(connStr: string, opts?: { continent?: string | null }): Promise<StayCountByCountry[]> {
  if (!connStr) throw new Error('Connection string required');
  const continent = opts?.continent ? String(opts.continent).trim() : null;

  let pool: any;
  try {
    pool = await sql.connect(connStr);
    const req = pool.request();

    let whereContinent = '';
    if (continent) {
      req.input('continentSearchPattern', sql.VarChar(100), `%${continent}%`);
      whereContinent = 'AND CO.CountryContinent LIKE @continentSearchPattern';
    }

    // Limited Listing stays are hidden from search and non-bookable, so only Live stays count.
    const query = `
      SELECT
        CO.CountryName AS country,
        CO.CountryCode2Alpha AS countryCode,
        CO.CountryContinent AS continent,
        COUNT(*) AS stays,
        SUM(CASE WHEN S.Listed = 1 AND (S.Suspended IS NULL OR S.Suspended = 0) THEN 1 ELSE 0 END) AS bookableNow
      FROM tbStays S
      INNER JOIN tbCountry CO ON S.Country = CO.CountryId
      WHERE S.IsDeleted != 'true' AND S.ListingStatus = 'Live' ${whereContinent}
      GROUP BY CO.CountryName, CO.CountryCode2Alpha, CO.CountryContinent
      ORDER BY COUNT(*) DESC, CO.CountryName
    `;

    const result = await req.query(query);
    return (result.recordset as any[]).map((r) => ({
      country: r.country,
      countryCode: r.countryCode ?? null,
      continent: r.continent ?? null,
      stays: Number(r.stays),
      bookableNow: Number(r.bookableNow),
    }));
  } finally {
    try { await pool?.close(); } catch { /* ignore */ }
  }
}
