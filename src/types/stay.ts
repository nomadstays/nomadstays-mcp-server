export interface Stay {
  EntryId: number;
  Title: string;
  FullName?: string | null;
  City?: string | null;
  Country?: string | number | null;
  URL?: string | null;
  CountryName?: string | null;
  CountryCode2Alpha?: string | null;
  location_name: string;
  GeoLat?: string | number | null;
  GeoLng?: string | number | null;

  // schema.org / staydetail fields
  Address?: string | null;
  State?: string | null;
  PostCode?: string | null;
  NumberOfRooms?: number | null;
  CheckinFrom?: string | null;
  CheckoutTo?: string | null;
  PetsAllowed?: boolean | null; // boolean per schema.org (true/false)
  Description?: string | null;
  MainImageName?: string | null;
  ImageName?: string | null;
  OgImage?: string | null; // computed URL to CDN
  AllImages?: string[] | null;
  AmenityFeatures?: string[] | null;
  MinPrice?: number | null;
  // priceRange is a human readable string already converted as desired (e.g. "From USD$905 per week")
  priceRange?: string | null;
  priceCurrency?: string | null; // ISO code, e.g. 'USD'
  Offers?: Array<{ '@type'?: string, description?: string, price?: number, priceCurrency?: string, availability?: string, validFrom?: string, validThrough?: string }> | null;

  // WiFi speed data
  WiFiDownloadSpeed?: number | null; // Download speed in Mbps
  WiFiUploadSpeed?: number | null; // Upload speed in Mbps
  WiFiJitter?: number | null; // Jitter in ms
  WiFiLastUpdatedTime?: string | null;

  // public stay identifier (derived from EntryId)
  StayId?: number | null;

  // optional JSON-LD block representing schema.org structured data
  jsonLd?: Record<string, any> | null;
}