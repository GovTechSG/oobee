/**
 * Known accessibility overlay vendors and their basic signatures.
 *
 * This list is intentionally conservative. It is better to miss a variant
 * than to accidentally block a legitimate, unrelated script.
 *
 * Extend as needed if you find additional stable URLs or DOM markers.
 */

export interface OverlayVendor {
  name: string;
  urlPatterns: string[];
  domSignatures: string[];
  globalObjects: string[];
}

export const overlayVendors: OverlayVendor[] = [
  {
    name: 'UserWay',
    urlPatterns: [
      '**://cdn.userway.org/**',
      '**://*.userway.org/widgetapp/**',
      '**://*.userway.org/code/**',
      '**://*.userway.org/api/**',
    ],
    domSignatures: [
      '#userwayAccessibilityIcon',
      '.userway',
      '.uwy',
      '[data-userway-widget]',
      'script#a11yWidgetSrc',
    ],
    globalObjects: ['UserWay'],
  },
  {
    name: 'accessiBe',
    urlPatterns: ['**://acsbapp.com/**', '**://acsbcdn.com/**', '**://cdn.accessibe.com/**'],
    domSignatures: [
      '#acsb-widget',
      '.acsb-widget',
      'iframe#acsb-iframe',
      "script[src*='acsbapp.com'],script[src*='accessibe']",
    ],
    globalObjects: ['acsbJS', 'acsb'],
  },
  {
    name: 'EqualWeb',
    urlPatterns: ['**://cdn.equalweb.com/**', '**://eqweb.net/**', '**://*.equalweb.com/**'],
    domSignatures: [
      '#ew_widget',
      '.ew-accessibility-menu',
      '[data-equalweb]',
      "script[src*='equalweb']",
    ],
    globalObjects: ['EqualWeb'],
  },
  {
    name: 'AudioEye',
    urlPatterns: ['**://ws.audioeye.com/**', '**://cdn.audioeye.com/**', '**://*.audioeye.com/**'],
    domSignatures: [
      '#ae-toolbar',
      '.ae-toolbar',
      "iframe[src*='audioeye'],script[src*='audioeye']",
    ],
    globalObjects: ['AudioEye'],
  },
  {
    name: 'Monsido',
    urlPatterns: [
      '**://app.monsido.com/**',
      '**://cdn.monsido.com/**',
      '**://scripts.monsido.com/**',
    ],
    domSignatures: ['#monsido_tooltip_wrapper', '.monsido-toolbar', "script[src*='monsido']"],
    globalObjects: ['MonsidoPageAssist', 'Monsido'],
  },
];

/**
 * Utility to get all URL patterns across vendors, for routing.
 */
export function getAllOverlayUrlPatterns(): string[] {
  return overlayVendors.flatMap(vendor => vendor.urlPatterns);
}
