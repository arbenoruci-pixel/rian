import React from 'react';
import PaySheetPortal from './PaySheetPortal';

// Backwards-compat wrapper (some pages used to import PaySheet)
export default function PaySheet(props) {
  return <PaySheetPortal {...props} />;
}
