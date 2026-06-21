
'use client';
import { useState } from 'react';

export default function RiplanPanel({ order, onClose, onSave }) {
  const [note, setNote] = useState(order?.data?.reschedule_note || '');
  const [at, setAt] = useState(order?.data?.reschedule_at || '');

  if (!order) return null;

  const quick = (mins) => {
    const d = new Date(Date.now() + mins * 60000);
    setAt(d.toISOString().slice(0,16));
  };

  return (
    <div className="riplanPanel">
      <h3>RIPLANIFIKO</h3>

      <div className="chips">
        <button onClick={()=>quick(30)}>+30m</button>
        <button onClick={()=>quick(60)}>+1h</button>
        <button onClick={()=>quick(180)}>+3h</button>
      </div>

      <input
        type="datetime-local"
        value={at}
        onChange={e=>setAt(e.target.value)}
      />

      <textarea
        placeholder="Shënim..."
        value={note}
        onChange={e=>setNote(e.target.value)}
      />

      <div className="actions">
        <button onClick={()=>onSave({at,note})}>RUAJ</button>
        <button onClick={onClose}>MBYLL</button>
      </div>
    </div>
  );
}
