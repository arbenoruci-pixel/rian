"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function ArkaStaffPage() {
  const [staff, setStaff] = useState([]);

  useEffect(() => {
    loadStaff();
  }, []);

  async function loadStaff() {
    try {
      const { data, error } = await supabase
        .from("staff")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Staff load error:", error);
        return;
      }

      setStaff(data || []);
    } catch (e) {
      console.error("Unexpected staff load error:", e);
    }
  }

  return (
    <div className="staff-page">
      <h1>PUNTORËT</h1>

      <div className="staff-list">
        {staff.map((s) => (
          <div key={s.id} className="staff-row">
            <div className="name">{s.name || "—"}</div>
            <div className="pin">****</div>
          </div>
        ))}
      </div>

      <style jsx>{`
        .staff-page {
          padding: 20px;
        }

        h1 {
          font-size: 20px;
          margin-bottom: 20px;
        }

        .staff-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .staff-row {
          display: flex;
          justify-content: space-between;
          padding: 12px;
          border-radius: 8px;
          background: #111;
          color: white;
        }

        .name {
          font-weight: 600;
        }

        .pin {
          letter-spacing: 3px;
        }
      `}</style>
    </div>
  );
}