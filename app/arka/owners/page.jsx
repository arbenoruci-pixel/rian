"use client";
import React from "react";
import Link from "next/link";

export default function Page(){
  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">ARKA • OWNER SPLIT</div>
          <div className="sub">LOCAL</div>
        </div>
        <Link className="ghostBtn" href="/arka">KTHEHU</Link>
      </div>
      <div className="card">
        <div className="muted">KJO FAQE ËSHTË NË PROCES. (UI pro u rregullua te ARKA • CASH dhe PUNTORET.)</div>
      </div>
      <style jsx>{`
        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 40px;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .title{font-size:34px;letter-spacing:1px;font-weight:900;}
        .sub{opacity:.75;margin-top:4px;font-size:13px;letter-spacing:.8px;text-transform:uppercase;}
        .ghostBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:.6px;}
        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:16px;padding:14px 14px 12px;margin:12px 0;}
        .muted{opacity:.7;padding:8px 0;}
      `}</style>
    </div>
  );
}
