// app/arka/cash/page.jsx
import dynamicImport from "next/dynamic";

export const dynamic = "force-dynamic";

const CashClient = dynamicImport(() => import("./CashClient"), { ssr: false });

export default function ArkaCashPage() {
  return <CashClient />;
}