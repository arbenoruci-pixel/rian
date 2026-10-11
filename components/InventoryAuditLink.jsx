import React from 'react';
import { Link } from 'react-router-dom';
import { getActor } from '@/lib/actorSession';
import { canAuditInventory } from '@/lib/inventoryAudit';

export default function InventoryAuditLink({ stage = 'ready' }) {
  if (!canAuditInventory(getActor()?.role)) return null;
  return <Link to={`/auditimi?stage=${stage}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: '0 14px', borderRadius: 12, background: '#fbbf24', color: '#171000', fontSize: 13, fontWeight: 900, textDecoration: 'none' }}>AUDITIMI</Link>;
}
