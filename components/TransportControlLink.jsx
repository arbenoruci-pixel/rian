import React from 'react';
import { Link } from 'react-router-dom';
import { getActor } from '@/lib/actorSession';
import { isBujar, canReviewBonusEvidence } from '@/lib/baseBonusEvidence';
export default function TransportControlLink(){
 const actor=getActor();if(!isBujar(actor)&&!canReviewBonusEvidence(actor))return null;
 return <Link to="/kontrolli-transportit" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'18px 20px',margin:'12px 0',borderRadius:18,border:'1px solid #55d9b755',background:'linear-gradient(120deg,#143c37,#16303b)',color:'#e6fff7',textDecoration:'none',fontWeight:850,minHeight:64}}><span>✓ {isBujar(actor)?'Kontrollo transportin':'Aprovo kontrollet e transportit'}<small style={{display:'block',marginTop:5,fontWeight:500,color:'#a8d7cb'}}>Foto · Kontroll · Aprovim</small></span><strong style={{color:'#f8dc99',whiteSpace:'nowrap'}}>+0.50 € →</strong></Link>;
}
