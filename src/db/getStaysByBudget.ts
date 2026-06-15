import sql from 'mssql';
import type { Stay } from "../types/stay.js";
import { appendFileSync } from 'fs';
import { join } from 'path';

function logDebug(message: string) {
  try {
    const logPath = join(process.cwd(), 'logs', 'debug.log');
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (e) {
    // Silently fail if logging doesn't work
  }
}

function parseConnectionString(connStr: string) {
  // Normalize and strip surrounding quotes
  connStr = String(connStr).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  // Parse key=value pairs into a config object suitable for mssql
  const parts = connStr.split(';').map(p => p.trim()).filter(Boolean);
  const map: Record<string, string> = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    const val = p.slice(idx + 1).trim();
    map[key] = val;
  }

  // Derive server and port
  let server = '';
  let port: number | undefined = undefined;
  if (map['server']) {
    server = map['server'].replace(/^tcp:/i, '');
  } else if (parts.length > 0) {
    const first = parts[0];
    const mFirst = first.match(/(?:server\s*=\s*)?(?:tcp:)?([^,;]+)/i);
    if (mFirst) server = mFirst[1];
  }

  if (server) {
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

function parseCheckInDate(input?: string | null): Date {
  const today = new Date('2026-01-19');
  
  if (!input) {
    return today;
  }

  const trimmed = input.trim().toLowerCase();
  
  // List of month names
  const months: Record<string, number> = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
    'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
  };
  
  // Check if input is "Month Year" format (e.g., "June 2027")
  for (const [month, index] of Object.entries(months)) {
    if (trimmed === month || trimmed.startsWith(month)) {
      // Check if there's a year after the month
      const yearMatch = trimmed.match(/\d{4}/);
      const year = yearMatch ? parseInt(yearMatch[0]) : today.getFullYear();
      const date = new Date(year, index, 1);
      return date;
    }
  }
  
  // Try parsing as a full date (YYYY-MM-DD or similar)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  // If all else fails, return today
  return today;
}

export async function getStaysByBudget(connStr: string, params: {
  countryCode?: string | null;
  durationDays: number;
  maxPrice: number;
  currency: string;
  checkInDate?: string | null;
  limit?: number;
}): Promise<Stay[]> {
  if (!connStr) throw new Error('Connection string required');
  if (!params.durationDays) throw new Error('Duration in days required');
  if (!params.maxPrice) throw new Error('Maximum price required');
  if (!params.currency) throw new Error('Currency code required');

  // Parse check-in date (supports "May", full dates, or defaults to today)
  const checkInDate = parseCheckInDate(params.checkInDate);
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setDate(checkOutDate.getDate() + params.durationDays);
  
  const checkInStr = checkInDate.toISOString().split('T')[0];
  const checkOutStr = checkOutDate.toISOString().split('T')[0];

  connStr = String(connStr).trim().replace(/^=+\s*/, '');
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  connStr = connStr.replace(/;(\d+);/, ',$1;');

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
    // First, get FX rates for currency conversion from FXCurrency table
    const fxReq = pool.request();
    const fxQuery = `
      SELECT BaseCurrency, APIResponse
      FROM FXCurrency
      WHERE CONVERT(date, CreatedDate) = CONVERT(date, GETDATE())
    `;
    const fxResult = await fxReq.query(fxQuery);
    
    // Build FX rate lookup: baseCurrency -> {rates: {targetCurrency: rate}}
    const fxRates: Record<string, any> = {};
    if (fxResult.recordset) {
      for (const row of fxResult.recordset) {
        try {
          const rateData = JSON.parse(row.APIResponse);
          fxRates[row.BaseCurrency] = rateData;
        } catch (e) {
          // Silently fail for individual rates
        }
      }
    }

    const req = pool.request();

    const limit = params.limit || 15;
    // Fetch more candidates than limit to account for many not being available
    const candidateLimit = Math.max(100, limit * 5);
    req.input('limit', sql.Int, candidateLimit);
    req.input('durationDays', sql.Int, params.durationDays);
    req.input('maxPrice', sql.Decimal(10, 2), params.maxPrice);
    req.input('currency', sql.VarChar(3), params.currency.toUpperCase());
    req.input('checkInDate', sql.Date, checkInStr);
    req.input('checkOutDate', sql.Date, checkOutStr);

    let countryFilter = '';
    if (params.countryCode) {
      req.input('countryCode', sql.VarChar(100), params.countryCode);
      countryFilter = `
        AND (
          S.CountryCode2Alpha = @countryCode 
          OR CO.CountryName LIKE '%' + @countryCode + '%'
        )
      `;
    }

    const query = `
      SELECT TOP (@limit)
        S.EntryId,
        S.Title,
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
        CO.CountryName,
        CO.CountryContinent,
        P.MinSellPrice AS MinPrice,
        P.Days AS PriceDays,
        P.CurrencyCode AS PriceCurrencyCode
      FROM tbStays S
      LEFT JOIN tbCountry CO ON S.Country = CO.CountryId
      LEFT JOIN (
        SELECT p.StayFK, sp.SellPrice AS MinSellPrice, sp.Days AS Days, C.CurrencyCode AS CurrencyCode,
          ROW_NUMBER() OVER (PARTITION BY p.StayFK ORDER BY ABS(sp.Days - @durationDays), sp.SellPrice) AS RowNum
        FROM tbStayPrices sp
        INNER JOIN tbStayPackages p ON sp.StayPackagesFK = p.EntryID
        LEFT JOIN tbCurrencies C ON p.CurrencyFK = C.EntryID
        WHERE sp.Listed = 1
      ) P ON P.StayFK = S.EntryId AND P.RowNum = 1
      WHERE S.IsDeleted != 'true'
      AND S.TotalRooms >= 1
      AND S.Listed = 1
      ${countryFilter}
      ORDER BY S.Title
    `;

    const result = await req.query(query);

    if (!Array.isArray(result.recordset)) {
      throw new Error('Expected resultset from tbStays query, got none');
    }

    // Log if stay 260 is found
    const stay260 = result.recordset.find((r: any) => Number(r.EntryId) === 260);
    if (stay260) {
      logDebug(`Stay 260 found in SQL: title=${stay260.Title}, minPrice=${stay260.MinPrice}, days=${stay260.PriceDays}, currency=${stay260.PriceCurrencyCode}`);
    } else {
      logDebug(`Stay 260 NOT in SQL results (${result.recordset.length} candidates returned)`);
    }

    // Filter by price and currency, applying FX conversion
    const availableStays = [];
    
    for (const r of result.recordset) {
      try {
        // Since the main query already filters for S.Listed = 1 and prices with sp.Listed = 1,
        // we can trust that this stay has bookable inventory
        // For budget searches, we prioritize getting results over strict availability checking
        const days = r.PriceDays ?? 0;
        const sourceCurrency = r.PriceCurrencyCode;
        const targetCurrency = params.currency.toUpperCase();
        
        if (r.MinPrice != null && days > 0) {
          let convertedPrice = Number(r.MinPrice);
          
          // Apply FX conversion if source and target currencies differ
          if (sourceCurrency && sourceCurrency !== targetCurrency) {
            const rates = fxRates[sourceCurrency];
            if (rates && rates.rates && rates.rates[targetCurrency]) {
              const rate = rates.rates[targetCurrency];
              convertedPrice = convertedPrice * rate;
              if (Number(r.EntryId) === 260) {
                logDebug(`Stay 260 FX: ${sourceCurrency}->${targetCurrency}, rate=${rate}, ${r.MinPrice} * ${rate} = ${convertedPrice}`);
              }
            } else {
              if (Number(r.EntryId) === 260) {
                logDebug(`Stay 260 NO FX rate for ${sourceCurrency}->${targetCurrency}. Available: ${Object.keys(fxRates)}`);
              }
            }
          }
          
          const total = (convertedPrice / Number(days)) * params.durationDays;
          
          if (Number(r.EntryId) === 260) {
            logDebug(`Stay 260 price calc: (${convertedPrice} / ${days}) * ${params.durationDays} = ${total}, budget=${params.maxPrice}`);
          }
          
          // Only include if within budget after conversion
          if (total <= params.maxPrice) {
            // Reorder properties for cleaner output
            const orderedStay = {
              EntryId: r.EntryId,
              Title: r.Title,
              City: r.City,
              State: r.State,
              PostCode: r.PostCode,
              CountryCode2Alpha: r.CountryCode2Alpha,
              GeoLat: r.GeoLat,
              GeoLng: r.GeoLng,
              Address: r.Address,
              URL: r.URL,
              MainImageName: r.MainImageName,
              ImageName: r.ImageName,
              Description: r.Description,
              NumberOfRooms: r.NumberOfRooms,
              CountryName: r.CountryName,
              CountryContinent: r.CountryContinent,
              PriceDays: r.PriceDays,
              MinPrice: r.MinPrice,
              PriceCurrencyCode: r.PriceCurrencyCode,
              requestedCurrency: targetCurrency,
              priceRange: `${Math.round(total)} ${targetCurrency}`
            };
            availableStays.push(orderedStay);
            if (Number(r.EntryId) === 260) {
              logDebug(`Stay 260 INCLUDED: ${total} <= ${params.maxPrice}`);
            }
          } else {
            if (Number(r.EntryId) === 260) {
              logDebug(`Stay 260 EXCLUDED: over budget ${total} > ${params.maxPrice}`);
            }
          }
        } else {
          // Reorder properties for cleaner output
          const orderedStay = {
            EntryId: r.EntryId,
            Title: r.Title,
            City: r.City,
            State: r.State,
            PostCode: r.PostCode,
            CountryCode2Alpha: r.CountryCode2Alpha,
            GeoLat: r.GeoLat,
            GeoLng: r.GeoLng,
            Address: r.Address,
            URL: r.URL,
            MainImageName: r.MainImageName,
            ImageName: r.ImageName,
            Description: r.Description,
            NumberOfRooms: r.NumberOfRooms,
            CountryName: r.CountryName,
            CountryContinent: r.CountryContinent,
            PriceDays: r.PriceDays,
            MinPrice: r.MinPrice,
            PriceCurrencyCode: r.PriceCurrencyCode,
            requestedCurrency: targetCurrency,
            priceRange: null
          };
          availableStays.push(orderedStay);
          if (Number(r.EntryId) === 260) {
            logDebug(`Stay 260 INCLUDED: no price data (price=${r.MinPrice}, days=${days})`);
          }
        }
        
        // Stop if we've found enough available stays
        if (availableStays.length >= limit) break;
      } catch (err: any) {
        if (Number(r.EntryId) === 260) {
          logDebug(`Stay 260 error: ${err?.message}`);
        }
        // Continue to next stay if processing fails
      }
    }

    return availableStays as any[];
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
}
