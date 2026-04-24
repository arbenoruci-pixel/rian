function buildStartMessage() {
  const code = normalizeTcode(codeRaw);
  const pieces = Number(copeCount || 0);
  const shuma = Number(effectiveTotalEuro || totalEuro || 0).toFixed(2);

  return [
    `Përshëndetje ${name || ''},`,
    `Tepihat tuaj janë gati dhe brenda 1 ore nisen drejt jush.`,
    ``,
    `⚠️ TË LUTEM KONFIRMO:`,
    `Na kthe përgjigje për të konfirmuar që je në shtëpi. Nëse nuk e konfirmon, porosia NUK ngarkohet në furgon!`,
    ``,
    `KODI: ${code}`,
    `COPË: ${pieces}`,
    `TOTALI PËR PAGESË: ${shuma} €`,
    ``,
    `RREGULLORJA:`,
    `• Ne tentojmë dërgesën deri në 3 herë.`,
    `• Nëse nuk lajmërohesh, duhet të vish t'i marrësh vetë në depo,`,
    `• Ose do të aplikohet tarifë ekstra prej 5 € për t'i risjellë.`,
    ``,
    `Tel: ${COMPANY_PHONE_DISPLAY}`
  ].join('\n');
}
