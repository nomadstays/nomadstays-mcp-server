/**
 * Which Stays agents can see, and whether each one can be booked. One rule for every search
 * tool, matching the public site (staydetail.cshtml.cs) and the sitemap job
 * (NomadHangfire26 UpdateSitemapJob):
 *
 * - Every Stay whose owner account is open is visible, whatever its Listed status. Deleted
 *   Stays, and Stays whose owner is missing, closed (AspNetUsers.LockoutEnd = max) or
 *   suspended (UserProfile.Suspended = '1'), are not; the site answers 410 for those.
 * - A visible Stay is bookable when it is Listed and not a Limited Listing. Otherwise the agent
 *   should offer createStayEnquiry instead of quoteStayBooking/bookStay.
 * - Stays are shown under their real name (AI answers recommend properties by name), not the
 *   Limited Listing pseudonym (AltTitle).
 *
 * Both SQL fragments expect tbStays to be aliased as S.
 */

export const OPEN_ACCOUNT_STAY_FILTER = `
  ISNULL(S.IsDeleted, 0) = 0
  AND (EXISTS (SELECT 1 FROM AspNetUsers au WHERE au.Id = S.OwnerIdentityId AND au.LockoutEnd IS NULL)
       OR EXISTS (SELECT 1 FROM UserIdentityMap m JOIN AspNetUsers au ON au.Id = m.IdentityUserId
                  WHERE S.Owner > 0 AND m.LegacyUserId = S.Owner AND au.LockoutEnd IS NULL)
       OR EXISTS (SELECT 1 FROM webpages_Membership wm WHERE S.Owner > 0 AND wm.UserId = S.Owner AND wm.IsConfirmed = 1))
  AND NOT EXISTS (SELECT 1 FROM AspNetUsers au WHERE au.LockoutEnd > '2100-01-01'
                  AND (au.Id = S.OwnerIdentityId
                       OR au.Id IN (SELECT m.IdentityUserId FROM UserIdentityMap m WHERE S.Owner > 0 AND m.LegacyUserId = S.Owner)))
  AND NOT EXISTS (SELECT 1 FROM UserProfile up WHERE up.Suspended = '1'
                  AND (up.UserId = S.Owner
                       OR up.UserId IN (SELECT m.LegacyUserId FROM UserIdentityMap m WHERE m.IdentityUserId = S.OwnerIdentityId)))`;

export const BOOKABLE_COLUMN =
  `CASE WHEN S.Listed = 1 AND ISNULL(S.ListingStatus, '') <> 'LimitedListing' THEN 1 ELSE 0 END AS Bookable`;

// Bookable Stays first: with every open-account Stay visible, a capped result list would
// otherwise fill up with enquiry-only Stays.
export const BOOKABLE_FIRST_ORDER =
  `CASE WHEN S.Listed = 1 AND ISNULL(S.ListingStatus, '') <> 'LimitedListing' THEN 0 ELSE 1 END`;

export const NOT_BOOKABLE_STATUS = "enquire, not bookable";

/**
 * Turns the query's Bookable column into the fields agents read, and drops the columns that
 * only existed for the old pseudonym logic. Mutates and returns the row.
 */
export function applyBookingStatus<T extends Record<string, any>>(row: T): T {
  const bookable = row.Bookable === 1 || row.Bookable === true;
  (row as any).bookable = bookable;
  (row as any).bookingStatus = bookable ? "bookable" : NOT_BOOKABLE_STATUS;
  if (!bookable) {
    (row as any).bookingNote =
      "This Stay can't be booked online right now. Offer the member createStayEnquiry; the Nomad Stays team replies by email.";
  }
  delete (row as any).Bookable;
  delete (row as any).AltTitle;
  delete (row as any).ListingStatus;
  return row;
}
