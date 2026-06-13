// Client-only helper: download the current FLETORJA view as a PDF (no print dialog).
// Uses html2canvas + jsPDF.

import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export async function downloadPdf(elementId, filename = "fletore.pdf") {
  try {
    const el = document.getElementById(elementId);
    if (!el) return;

    // Render DOM to canvas
    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
    });

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let y = 0;
    while (y < imgHeight) {
      pdf.addImage(imgData, "PNG", 0, -y, imgWidth, imgHeight);
      y += pageHeight;
      if (y < imgHeight) pdf.addPage();
    }

    pdf.save(filename);
  } catch (e) {
    // Silent fail: we don't want PDF generation to block the UI.
    console.error("downloadPdf failed", e);
    alert("PDF nuk u krijua. Provo prapë.");
  }
}
