/**
 * Shared constants used across components
 */

// Plant types available for adding hypothetical generation nodes
export const PLANT_TYPES = [
  { value: 'Wind Offshore', label: 'Wind Offshore', color: '#3b82f6' },
  { value: 'Wind Onshore', label: 'Wind Onshore', color: '#60a5fa' },
  { value: 'Solar', label: 'Solar', color: '#fbbf24' },
  { value: 'Nuclear', label: 'Nuclear', color: '#a855f7' },
  { value: 'CCGT', label: 'CCGT (Gas)', color: '#f97316' },
  { value: 'OCGT', label: 'OCGT (Peaker)', color: '#ef4444' },
  { value: 'Hydro', label: 'Hydro', color: '#06b6d4' },
  { value: 'Pump Storage', label: 'Pumped Storage', color: '#0891b2' },
  { value: 'Biomass', label: 'Biomass', color: '#84cc16' },
  { value: 'Battery', label: 'Battery Storage', color: '#8b5cf6' },
  { value: 'Other', label: 'Other', color: '#6b7280' }
];

// All 27 TNUoS generation zones
export const ALL_ZONES = [
  'GZ1', 'GZ2', 'GZ3', 'GZ4', 'GZ5', 'GZ6', 'GZ7', 'GZ8', 'GZ9', 'GZ10',
  'GZ11', 'GZ12', 'GZ13', 'GZ14', 'GZ15', 'GZ16', 'GZ17', 'GZ18', 'GZ19', 'GZ20',
  'GZ21', 'GZ22', 'GZ23', 'GZ24', 'GZ25', 'GZ26', 'GZ27'
];
