import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import InventoryAuditPage from '../../app/auditimi/page.jsx';
createRoot(document.getElementById('root')).render(<BrowserRouter><InventoryAuditPage /></BrowserRouter>);
