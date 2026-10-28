import React from 'react';
import { Link } from 'react-router-dom';
import { getActor } from '@/lib/actorSession';
import { isBujar, canReviewBonusEvidence } from '@/lib/baseBonusEvidence';
export default function BonusEvidenceLink() {
  const actor = getActor();
  if (!isBujar(actor) && !canReviewBonusEvidence(actor)) return null;
  return <Link to="/arka/bonuset" style={{ display:'inline-flex',alignItems:'center',minHeight:44,padding:'0 14px',borderRadius:12,background:'#19654f',color:'#fff',fontSize:13,fontWeight:900,textDecoration:'none',margin:'6px 0' }}>{canReviewBonusEvidence(actor) ? 'PROVAT E BUJARIT · APROVIM' : 'FITO +24 ORË · PROVAT'}</Link>;
}
