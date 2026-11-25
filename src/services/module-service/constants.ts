/** The Boutique app billing through POS (20 Nov): its name here, its passes, and what a shop may grant it. */
export const MODULE = 'boutique';
/** A POS shop made for a boutique by the Boutique super admin's switch (25 Nov). */
export const MADE_BY_ADMIN = 'boutique-admin';
export const ISS = 'scaleezy-boutique';
export const AUD = 'scaleezy-pos';
export const SERVICE_SCOPES = ['pos:customer', 'pos:bill:create', 'pos:bill:read', 'pos:payment', 'pos:return', 'pos:day'] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];
