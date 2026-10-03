/**
 * Onboarding briefing for a Stay Partner's own AI agent: how to take a new property from
 * no account to a live, bookable listing using this server's tools. Served three ways from
 * this one source so they can't drift apart:
 *   - MCP prompt   "onboard-new-stay"            (clients that surface prompts, e.g. Claude)
 *   - MCP resource guide://onboarding/new-stay   (clients that read resources)
 *   - a pointer in the server's `instructions`   (every client sees this at initialize)
 * The same content is published for humans as the Help Center article
 * kb/onboarding-process/ai-agent-guide-onboarding-a-new-stay/ — keep the two in step.
 */

export const ONBOARDING_GUIDE_URI = "guide://onboarding/new-stay";
export const ONBOARDING_PROMPT_NAME = "onboard-new-stay";

export const onboardingGuideMarkdown = `# Onboarding a New Stay: Briefing for Partner AI Agents

This briefing tells an AI agent acting for a Stay owner how to take a new property from zero to a live, bookable listing on Nomad Stays using the Nomad Stays MCP tools. Work through it in order.

Every new Stay starts with an application. The applicant completes a Stay Application, usually pays a fee, and a person at Nomad Stays reviews it. You never create a Stay or a stayId yourself: there is no tool for it. Approval creates the Stay and issues its stayId, and every listing tool in Phase B needs that ID.

You are done when getMyStayOnboardingStatus reports no outstanding items, the Nomad Stays team has approved the Stay, and at least one listed package can be quoted for real dates.

## The journey at a glance

| Step | Who | What |
| --- | --- | --- |
| 1 | Agent | Only if the owner has no account yet: signupNomadStaysAccount |
| 2 | Owner, in browser | Confirm email, enable 2FA, connect the agent (OAuth) |
| 3 | Agent | Fill the application until no missingFields |
| 4 | Owner, in browser | Pay the EUR 39 fee via checkoutUrl (agent polls) |
| 5 | Agent | submitStayApplication |
| 6 | Nomad Stays team | Review and approve; issues the new stayId (Stay starts unlisted) |
| 7 | Agent | Build the listing: details, rooms, packages, photos |
| 8 | Owner, in browser | Availability feed (iCal), Wi-Fi speed test, tax and bank details |
| 9 | Nomad Stays team | Set the Stay live (Listed flag is admin-controlled) |

## Before you start

You need a confirmed account and a connection the owner has authorised. You cannot create either silently on their behalf.

1. Account. Only if the owner has no Nomad Stays account yet, call signupNomadStaysAccount with their real name, email, phone and a password. The account stays inactive until the owner clicks the confirmation email. You get no session or token back.
2. Connect the agent. The owner signs in at www.nomadstays.com/Account/Login. Most agents use the self-service OAuth "Connect an AI agent" flow (server https://mcp.nomadstays.com/mcp). A manual bearer token is only for clients that cannot do OAuth; it is issued from the Operator Information page (/stayadmin/user-profile-stays). Both need 2FA on the account.
3. Check fit. Nomad Stays lists apart-hotels, apartments, boutique hotels, pensions, hostels and co-living, rental houses, gites and farm-stays, castles and manors, boats, treehouses and camping. It does NOT list home-stays where the owner lives with guests, rooms in a domestic house, or request-first properties. Stop and tell the owner if the property does not fit.
4. Fee. Every application carries a one-time fee of EUR 39, waived only for an existing Stay Partner adding another Stay. The application itself is never skipped.

Gather this from the owner in one pass:
- Applicant name, email, mobile, legal business name
- Postal/billing address and country; VAT number if that country requires one
- Stay name and its country; tourism/lodging registration number if that country requires one
- Business model: BookingFlow (Nomad Stays takes bookings and payment) or StayDirect (direct bookings, 1% advertising fee)
- Indicative monthly wholesale price in USD (the application is always in USD), number of rooms, kitchen, laundry, work facilities, measured download speed, website, how availability is kept up to date
- Full street address and map pin, check-in/out times, pets/children/parking rules, cancellation policy
- Per room: name, description, bed sizes, max guests, room amenities
- Per package: which room, the currency it is priced in (any supported currency), max guests, wholesale price for each of 7, 14, 21 and 30 nights
- Photos: hero, gallery and workspace (landscape, min 1920x1080), photos per room, and a portrait of the contact person (min 1080x1350)
- Owner, day-to-day manager and booking contact details; social links; languages spoken

## Phase A: apply and get approved

1. Call listStayApplications. If a draft exists, resume it. Each application has a nextAction hint.
2. Call getCountryOptions. Each country has vatNumberRequired, tourismNumberRequired and bookingModelsRestricted. Check the Stay country and the billing country separately.
3. Call getBusinessModelOptions. If the Stay country has bookingModelsRestricted, only a StayDirect model is accepted. The business model cannot be changed later by you or the owner, so confirm it with them.
4. Call createStayApplication with everything you have; add the rest later with saveStayApplication. The monthlyPrice on the application is always in USD; convert if the owner quotes another currency. Package currencies are chosen later.
5. Call getStayApplication; its missingFields list names every empty required field. Save until it is empty.
6. Call getProductInfo(productId 8). If isWaivedForCaller is true, purchaseProduct resolves as "waived". Otherwise purchaseProduct(productId 8, applicationId) returns a checkoutUrl: give it to the owner to pay in their own browser, then poll getPurchaseStatus with the saleId. Never accept the owner's word that they paid.
7. Call submitStayApplication. It fails with missingFields, or 409 if the fee is unpaid. On success the application goes to human review.
8. Poll listStayApplications (daily is enough) until nextAction is "accepted". On approval Nomad Stays creates the Stay and issues its stayId; there is no tool to create one. Call getMyStays to find it.

## Phase B: build the listing

The new Stay starts unlisted with placeholder values: the title is cut to 35 characters, and the address, policies and accommodation type are blank or defaults. Overwrite all of them. Always read before you write.

1. Stay details: getMyStayDetail, then updateStayDetail with the full title and a guest-facing description written for remote workers (workspace, Wi-Fi, neighbourhood, long-stay value).
2. Organisational data: getMyStayOrganisationalData, then updateStayOrganisationalData with address, city, post code, countryId, geoLat/geoLng, check-in/out times, stayTypeId, totalRooms, cxPolicyId, pets/children/parking IDs, tourism number, and three "Why Choose Us" reasons. Look up IDs with getStayTypeOptions, getCancellationPolicyOptions and getAdditionalInformationOptions. Only set fullPayment if fullPaymentAllowedByCountry is true.
3. Contacts: getMyStayContacts, then updateStayContacts (owner, day-to-day manager, booking email/phone, host display name, website, social links).
4. Facilities: getFacilityGroups, then for each group (General, Services, Languages Spoken, Meal, Position, Remote Worker) getMyStayFacilities and updateStayFacilities with the COMPLETE list of selected IDs.
5. Rooms: getRoomTypeOptions and getRoomFacilityOptions, then createStayRoom per room with title, description, beds, bed sizes, maxPerson and room amenities. Record each room ID.
6. Packages: getCurrencyOptions, then createStayPackage per room. Pass stayRoomFK explicitly, set currencyFK to the currency the owner chooses for that package (required; packages can use different currencies, so ask), maxPax, listed: true, startDate today and endDate at least 12 months out, a description of about 150 characters, and price tiers for 7/14/21/30 nights with listed: true.
7. Photos: uploadStayPhoto for "main" (hero), "listing" (gallery), "workspace", one "host" portrait, and "room" photos per roomId. Then reorderStayPhotos so the strongest image leads.
8. Business profile: getMyBusinessProfile, then updateHostBusinessProfile (legal name, VAT/business registration numbers).

## Checking progress

Call getMyStayOnboardingStatus. It returns the six Listing Completion cards from the owner's dashboard.

| Card | What drives it | Who fixes it |
| --- | --- | --- |
| Stay Details | Recalculated after every agent edit to details, organisational data, contacts, facilities or photos | Agent |
| Availability | Stored score for room availability | OWNER on the website: connect an iCal feed per room (Rooms page, Inbound iCal, Test) or set allocation in the extranet |
| Rooms | Stored score for room setup | Agent |
| Packages | Live: 75% for active package dates covering the next 365 days, 25% for a package description up to 150 characters | Agent |
| Wi-Fi | Live: 100% on the day of a speed test, falling to 0% after a year (not a speed rating) | OWNER on the website, on the property's Wi-Fi. Not available to agents |
| Operator Information | Same score as the owner's dashboard; missingItems lists what is outstanding (e.g. Date of Birth, Banking Details) | OWNER on the website: tax and bank details (DAC7 for BookingFlow) are never exposed to agents. Relay the missingItems list |

Rooms without a live availability source (iCal, MCP or API feed, or 90 days manually confirmed) fall into Limited Listing: visible but not bookable. Push the owner to connect a calendar feed rather than rely on manual 90-day confirmations, which expire.

Then test end to end: getAvailabilityByMonth or findNearestAvailability for each room, then quoteStayBooking for a 30-night stay. If no quote comes back, a package, price tier or availability source is missing. Finally tell the owner the listing is ready for the Nomad Stays team to set it live.

## Rules and common mistakes

- Replace-all lists: updateStayFacilities, updateStayRoom (roomFacilityFk), updateStayPackage (prices), reorderStayPhotos and reorderRoomPhotos replace the whole list. Read first and send the complete set.
- Lookup IDs, not text: country, accommodation type, cancellation policy, pets, children and parking are IDs. Never send "Yes", a country name or a boolean.
- Prices are wholesale: buyPrice is what the owner receives. The guest price is computed by Nomad Stays (buyPrice / 0.88 for BookingFlow; equal to buyPrice for advertising models). You cannot set the sell price.
- Fixed tiers: 7, 14, 21 or 30 nights only, one row per tier. A subset is fine; the minimum booking is 7 nights.
- Two Listed flags: a package is only bookable when both the package and its price tier are listed, and the package dates cover the check-in.
- Always pass stayRoomFK, or the server guesses the room and can attach the package to the wrong one.
- New Stays start as Boutique: room types are fixed slots (Boutique1 to Boutique6) and creation stops at 6 rooms. Larger properties need the Nomad Stays team to switch the Stay to the standard (Commercial) model.
- Photos: JPEG, PNG or WebP, under 20 MB; landscape min 1920x1080 for main/listing/workspace/room; portrait min 1080x1350 for host. Use a public url OR base64, not both. Real photos of the property only.
- Hard deletes: deleteStayPackage is permanent. Prefer updateStayPackage with isActive: false. Confirm with the owner before any delete.
- Never invent facts. Amenities, Wi-Fi speeds, registration numbers and policies are commitments to guests. If the owner has not told you, ask.
- Out of scope for agents: bank and tax details, the Stay's Listed status, the business model, availability calendars, Wi-Fi tests.
- Wording: "Nomad Stays" is two words. Call the owner's business a Stay Partner or Trusted Stay Partner, not a host.

## Getting help

Search the Help Center before guessing: searchHelpCenter, then getHelpCenterArticle. Useful categories: Onboarding Process, Application Process, Availability and Rooms, iCAL, Pricing & Packages, Photos and Images, Stay Details, StayDirect, DAC 7 Reporting in the EU.

Hand off to the owner, then Nomad Stays (WhatsApp or https://www.nomadstays.com/contact-us), when a validation error persists after you corrected the input, the property may not fit the criteria, the application has been in review for more than a few working days, the owner needs more than 6 rooms on a Boutique Stay, or the owner asks for anything out of scope.
`;

/** Prompt body: the guide plus a short task framing, optionally pinned to a stayId. */
export function buildOnboardingPromptText(stayId?: string): string {
  const task = stayId
    ? `Help me finish onboarding my Stay (stayId ${stayId}) on Nomad Stays. Start with getMyStayOnboardingStatus for that Stay, tell me what is outstanding, then work through Phase B of the briefing below, asking me for anything you don't have.`
    : `Help me onboard a new Stay on Nomad Stays. First check listStayApplications and getMyStays to see where I already am, then follow the briefing below from that point, asking me for anything you don't have.`;
  return `${task}\n\n---\n\n${onboardingGuideMarkdown}`;
}
