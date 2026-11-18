// Request and response shapes of the public API. Field names are the wire names (snake_case).

export type VehicleType = 'auto' | 'camioneta' | 'motocicleta' | 'camion' | 'otro';
export type ServiceCategory = 'vial' | 'colision';
export type TowTruckClass = 'A' | 'B' | 'C' | 'D';
export type Accessory =
  | 'dolly' | 'winch' | 'cadenas' | 'eslingas' | 'patines' | 'rampas' | 'barra_tiro' | 'extension_pluma'
  | 'gato_hidraulico' | 'pasacorriente' | 'compresor' | 'luces_remolque';

export interface Place {
  /** Required, up to 500 characters. */
  address: string;
  /** Latitude and longitude go together. Without pickup and destination coordinates there is no estimated price. */
  lat?: number;
  lng?: number;
}

/** Body of `POST /service-requests`. Unknown fields are rejected with `validation_error`. */
export interface ServiceRequestInput {
  /** Your own reference (claim or case number), up to 64 characters. */
  external_ref?: string;
  contact: {
    /** Up to 120 characters. */
    name: string;
    /** International format (+52...); 10 digits are taken as a Mexican number. */
    phone: string;
  };
  vehicle?: {
    make?: string;
    model?: string;
    year?: number;
    color?: string;
    plate?: string;
    type?: VehicleType;
  };
  pickup: Place;
  destination?: Place;
  service?: {
    reason?: string;
    category?: ServiceCategory;
    required_class?: TowTruckClass;
    required_accessories?: Accessory[];
  };
  /** Up to 1,000 characters and 20 lines. */
  notes?: string;
}

export type ServiceRequestStatus =
  | 'received' | 'quoted' | 'confirmed' | 'in_progress' | 'completed' | 'rejected' | 'cancelled' | 'expired';

export type UnpricedReason =
  | 'missing_coordinates' | 'missing_destination' | 'no_zones_configured' | 'missing_vehicle_class';

export interface EstimatedPrice {
  currency: 'MXN';
  subtotal: number;
  taxes: { name: string; type: 'tax' | 'retention'; rate: number; amount: number }[];
  tax_total: number;
  retention_total: number;
  total: number;
}

export interface Quote {
  /** `null` when the request could not be priced automatically; see `unpriced_reason`. */
  estimated_price: EstimatedPrice | null;
  /** Always `false`: the estimate never includes extras such as tolls. */
  includes_extras: false;
  approximate_distance?: boolean;
  unpriced_reason: UnpricedReason | null;
  note?: string;
}

export interface ServiceRequest {
  id: string;
  object: 'service_request';
  status: ServiceRequestStatus;
  mode: 'test' | 'live';
  external_ref: string | null;
  created_at: string;
  resolved_at: string | null;
  rejection_reason: string | null;
  service: { folio: string | null; status: string } | null;
  quote: Quote;
  assignment: {
    operator_first_name: string | null;
    truck: { economic_number: string | null; plate: string | null } | null;
  } | null;
  timeline: {
    on_the_way_at?: string;
    on_site_at?: string;
    transport_started_at?: string;
    completed_at?: string;
  } | null;
}

export interface ServiceRequestList {
  object: 'list';
  /** Up to 20 requests, most recent first. */
  data: ServiceRequest[];
}

export type WebhookEventType =
  | 'service_request.quoted' | 'service_request.confirmed' | 'service_request.in_progress'
  | 'service_request.completed' | 'service_request.rejected' | 'service_request.cancelled'
  | 'service_request.expired' | 'service_request.assigned' | 'service_request.on_the_way'
  | 'service_request.on_site' | 'webhook.test';

/** Body of a webhook delivery. */
export interface WebhookEvent {
  /** Same value as the `X-GruaLink-Delivery` header and on every retry. Use it to deduplicate. */
  id: string;
  object: 'event';
  type: WebhookEventType | (string & {});
  mode: 'test' | 'live';
  created_at: string;
  data: {
    /** Previous status on status events; `null` on assigned, on_the_way and on_site. */
    previous_status?: ServiceRequestStatus | null;
    /** Same representation as `GET /service-requests/{id}` at that moment. */
    service_request?: ServiceRequest;
    /** Only on `webhook.test`. */
    message?: string;
  };
}
